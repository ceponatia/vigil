import { afterAll, describe, expect, it } from "vitest";

import { loadActiveReservations, loadExecutionAttempts, loadPositionPlan, recordApprovedIntent } from "@vigil/db";
import type { StoreApprovedIntent } from "@vigil/db";

import { authorizeProposal } from "./authorize";
import { dispatchAttempt } from "./dispatch";
import {
  MONEY_SCALE,
  NOW,
  capital,
  dispatchIds,
  fund,
  openExecutionTestDb,
  paperExchange,
  parsedQuote,
  policyConfig,
  portfolio,
  proposal,
  rawQuote,
  runtime,
  syntheticInstrument,
  venueConfig,
} from "./test-support/execution-fixtures";

/**
 * The defect this file kills: an `apps/trading` that restarts between
 * approving an intent and dispatching it cannot run the pre-dispatch
 * economic gate on the work it inherited.
 *
 * The gate measures gross edge as the thesis exit price against the FRESH
 * midpoint, and it judges the execution price against the approved entry
 * zone. `approved_intents` carries neither figure — it stores the *result*
 * of the approval — so both used to arrive on the in-process
 * `DispatchRequest`, held in the memory of whichever run approved the
 * intent. A process that did not approve it had nothing to run the gate
 * with, which is the one case where "the candidate having once been
 * attractive is not sufficient" stops being enforced at all.
 *
 * **The restart here is real, not a flag.** The approving pool is closed and
 * a second one is opened, against a fresh paper exchange, and the dispatch
 * is driven through the ordinary exported API. `DispatchRequest` has no
 * field for plan terms, so there is no in-memory value a case could smuggle
 * across the boundary even by accident — which is why this file cannot pass
 * against the shape it was written for.
 *
 * ## Why the decayed case is paired with an unmoved one
 *
 * A blocked dispatch on its own proves nothing about where the terms came
 * from: an intent whose plan read back as garbage, as an empty band, or as
 * nothing at all also blocks. The second half dispatches the SAME
 * authorization from the SAME restarted runtime against the book it was
 * approved at, and it must clear. Only the pair says the durable terms are
 * the real ones: good enough to pass when the market has not moved, and
 * refusing when it has.
 *
 * That second dispatch is only possible because the first left nothing
 * durable behind — no hold, no attempt, no outbox row — which the case
 * asserts rather than assumes.
 */

const approving = openExecutionTestDb("vigil-trading-restart-approving");
const restarted = openExecutionTestDb("vigil-trading-restarted");

afterAll(async () => {
  await approving.close();
  await restarted.close();
});

const VENUE = venueConfig();

/** Enough of the quote asset to cover any envelope these cases build. */
const FUNDING_BASE = 1_000_000n;

describe("revalidation after a restart", () => {
  it("skips an intent whose edge decayed since approval with INSUFFICIENT_NET_EDGE, from durable state alone, and still dispatches the same authorization at the book it was approved at — catches the gap that let a restarted process pay costs on a trade whose edge had evaporated because it had no way to ask, and the false comfort of a skip that blocks for some other reason entirely", async () => {
    const label = "restart";
    const instrument = syntheticInstrument(label);
    await fund(approving.db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    // ---- the approving run --------------------------------------------
    const authorized = await authorizeProposal(approving.db, {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: policyConfig(),
      portfolio: portfolio(),
      capital: capital(),
    });
    expect(authorized.outcome).toBe("authorized");
    if (authorized.outcome !== "authorized") {
      return;
    }

    // The approval's own terms, durable under the id the intent names. The
    // formation midpoint is asserted too: it is the figure that makes the
    // exit target readable later, and nothing else records it.
    expect(await loadPositionPlan(approving.db, `plan-${label}`)).toMatchObject({
      instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
      entryZoneMin: "200.00",
      entryZoneMax: "300.00",
      thesisExitPrice: "260.00",
      formationReferenceMid: "250.05",
    });

    // ---- the restart ---------------------------------------------------
    // A different pool and a different exchange. Nothing from the approving
    // run is reachable from here but the database.
    const after = runtime(restarted.db, paperExchange());

    // The market has moved almost all the way to the thesis target: the
    // 9.95 per-unit edge the approval cleared its hurdle on is now 1.95,
    // against 1.4559 of spread, slippage, fee and the flat cost. The entry
    // zone still admits the price, so this reaches the net-edge stage
    // rather than being turned away earlier — which is what makes the stage
    // assertion below load-bearing.
    const decayed = await dispatchAttempt(after, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      quote: rawQuote(instrument, { bidPrice: "258.00", askPrice: "258.10" }),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(`${label}-decayed`),
    });

    expect(decayed.outcome).toBe("blocked");
    if (decayed.outcome !== "blocked") {
      return;
    }
    // The stage AND the code. "Blocked" alone is satisfied by a plan that
    // read back as nothing, which refuses at `UNKNOWN_POSITION_PLAN` before
    // any economics are computed at all.
    expect(decayed.stage).toBe("netEdge");
    expect(decayed.reasonCode).toBe("INSUFFICIENT_NET_EDGE");
    expect(await loadExecutionAttempts(restarted.db, authorized.intentId)).toEqual([]);
    // No hold either, and this is the half that would rot quietly: the plan
    // is loaded before `reserveAvailable`, and a reordering that moved it
    // after would leave every ordinary skip holding capital against an
    // intent no exported path can release — a release needs a settled
    // attempt that actually spent something. A handful of skips would
    // strand the funding account while every attempt assertion above stayed
    // green.
    expect(await loadActiveReservations(restarted.db, instrument.quoteAssetId)).toEqual([]);

    // ---- the control: same runtime, same authorization, unmoved book ----
    const unmoved = await dispatchAttempt(after, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(`${label}-unmoved`),
    });

    expect(unmoved.outcome).toBe("dispatched");
    if (unmoved.outcome !== "dispatched") {
      return;
    }
    // The figure the durable terms produced, measured against the fresh
    // midpoint: 260.00 less 250.05. A per-unit edge frozen at approval
    // would produce this number at BOTH books, which is exactly the bug the
    // decayed half exists to catch.
    expect(unmoved.clearance.expectedGrossEdgePerUnitQuote).toBe("9.95");

    // And the hold the skip did not take, taken now — against the same
    // asset, through the same read. Without this the empty assertion above
    // would also pass if `loadActiveReservations` never reported a hold on
    // this instrument at all.
    expect(
      (await loadActiveReservations(restarted.db, instrument.quoteAssetId)).map((held) => held.intentId),
    ).toEqual([authorized.intentId]);
  });

  it("refuses to dispatch an authorization whose plan is not in durable history, holding no capital and opening no attempt — catches the gate inventing terms for an intent it cannot read a band for, which would clear a zone nobody approved; `approved_intents.position_plan_id` has no foreign key behind it yet, so this state is reachable", async () => {
    const label = "orphan";
    const instrument = syntheticInstrument(label);
    await fund(approving.db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    const authorized = await authorizeProposal(approving.db, {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: policyConfig(),
      portfolio: portfolio(),
      capital: capital(),
    });
    expect(authorized.outcome).toBe("authorized");
    if (authorized.outcome !== "authorized") {
      return;
    }

    // The same authorization, written again under fresh identities and a
    // plan id nobody recorded — the shape any writer that is not
    // `authorizeProposal` can still produce today.
    const unplanned: StoreApprovedIntent = {
      ...authorized.record,
      intentId: `intent-${label}-unplanned`,
      idempotencyKey: `idem-${label}-unplanned`,
      economicActionId: `action-${label}-unplanned`,
      positionPlanId: `plan-${label}-never-recorded`,
    };
    expect((await recordApprovedIntent(approving.db, unplanned)).outcome).toBe("recorded");

    const after = runtime(restarted.db, paperExchange());
    const refused = await dispatchAttempt(after, {
      intentId: unplanned.intentId,
      attempt: 1,
      instrument,
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(`${label}-unplanned`),
    });

    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") {
      return;
    }
    expect(refused.refusal.reason).toEqual({ source: "execution", code: "UNKNOWN_POSITION_PLAN" });
    expect(await loadExecutionAttempts(restarted.db, unplanned.intentId)).toEqual([]);
    expect(await loadActiveReservations(restarted.db, instrument.quoteAssetId)).toEqual([]);

    // The control for that empty hold list, and for the refusal being about
    // this intent rather than about this instrument: the sibling
    // authorization on the SAME asset — the one whose plan the approval did
    // record — dispatches, and the hold shows up under its id.
    const planned = await dispatchAttempt(after, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(`${label}-planned`),
    });

    expect(planned.outcome).toBe("dispatched");
    expect(
      (await loadActiveReservations(restarted.db, instrument.quoteAssetId)).map((held) => held.intentId),
    ).toEqual([authorized.intentId]);
  });
});
