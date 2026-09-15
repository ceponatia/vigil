import { afterAll, describe, expect, it } from "vitest";

import { loadApprovedIntent, loadDispatch, loadExecutionAttempts, loadJournalEntries } from "@vigil/db";
import type { PaperOrder, VenueBehavior } from "@vigil/adapter-paper";

import { authorizeProposal } from "./authorize";
import { clientOrderIdFor, dispatchAttempt, type ExecutionRuntime, type Instrument } from "./dispatch";
import { loadUnresolvedDispatches } from "./recover";
import { cancelAttempt, pollAttempt, reconcileAttempt } from "./settle";
import {
  MONEY_SCALE,
  NOW,
  capital,
  dispatchIds,
  fund,
  instant,
  money,
  openExecutionTestDb,
  paperExchange,
  parsedQuote,
  planTerms,
  policyConfig,
  portfolio,
  proposal,
  rawQuote,
  runtime,
  settlementIds,
  syntheticInstrument,
  venueConfig,
} from "./test-support/execution-fixtures";

/**
 * The fault matrix `docs/testing.md` names for this path, driven against the
 * real schema and the real simulated venue.
 *
 * | Scenario | Required result |
 * | --- | --- |
 * | Crash after exchange acceptance but before local acknowledgement | UNKNOWN then reconciliation; no blind duplicate |
 * | Partial exchange fill followed by cancellation | Filled exposure and fees persist; only the confirmed unfilled remainder released |
 *
 * Plus the two cases those two depend on being true:
 *
 *  * a dispatch blocked by something that is **not** a policy decision stays
 *    enqueued rather than being abandoned under a code policy never gave, and
 *    a restart can see it;
 *  * a cancellation whose confirmation was lost releases **nothing** —
 *    `CANCEL_PENDING` means requested and not confirmed, and the quantity
 *    still working could yet fill.
 *
 * The defects these kill are all forms of one mistake: resolving an
 * ambiguous outcome by assumption. A retry after an unacknowledged
 * submission double-spends; a release on an unconfirmed cancellation hands
 * back capital that is still committed; a cancellation that discards the
 * partial fill loses real exposure.
 *
 * Every case names its own synthetic asset pair — see
 * `test-support/execution-fixtures.ts` for why nothing here truncates.
 */

const { db, close } = openExecutionTestDb("vigil-trading-faults-test");
afterAll(close);

const VENUE = venueConfig();
const FUNDING_BASE = 1_000_000n;

type Scenario = {
  readonly instrument: Instrument;
  readonly intentId: string;
  readonly wiring: ExecutionRuntime;
};

/** Funds an asset pair, authorizes one intent against it, and wires a venue that behaves as told. */
async function scenario(label: string, behavior: VenueBehavior): Promise<Scenario> {
  const instrument = syntheticInstrument(label);
  await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

  const exchange = paperExchange({ behaviors: { [clientOrderIdFor(`idem-${label}`, 1)]: behavior } });
  const wiring = runtime(db, exchange);

  const authorized = await authorizeProposal(db, {
    proposal: proposal(label, instrument),
    quote: parsedQuote(instrument),
    now: NOW,
    operatingMode: "PAPER",
    venue: VENUE,
    policyConfig: policyConfig(),
    portfolio: portfolio(),
    capital: capital(),
  });
  if (authorized.outcome !== "authorized") {
    throw new Error(`scenario ${label} could not authorize: ${authorized.refusal.detail}`);
  }

  return { instrument, intentId: authorized.intentId, wiring };
}

async function dispatch(scene: Scenario, label: string): Promise<PaperOrder> {
  const dispatched = await dispatchAttempt(scene.wiring, {
    intentId: scene.intentId,
    attempt: 1,
    instrument: scene.instrument,
    plan: planTerms(),
    quote: rawQuote(scene.instrument),
    now: NOW,
    portfolio: portfolio(),
    ids: dispatchIds(label),
  });
  if (dispatched.outcome !== "dispatched") {
    throw new Error(`scenario ${label} did not reach the venue: ${JSON.stringify(dispatched)}`);
  }
  return dispatched.order;
}

describe("crash after exchange acceptance but before local acknowledgement", () => {
  it("leaves the attempt UNKNOWN, refuses a second attempt outright, and resolves only through reconciliation", async () => {
    const label = "unknown";
    // The venue accepted the order and the response was lost. The caller
    // cannot tell that from the venue never having seen it, which is exactly
    // what UNKNOWN is for.
    const scene = await scenario(label, {
      submission: { kind: "TIMEOUT", venueAccepted: true },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
    });
    const order = await dispatch(scene, label);

    expect(order.state).toBe("UNKNOWN");
    // The caller observed nothing, so the record must not imply it did.
    expect(order.venueOrderId).toBeNull();

    const afterDispatch = await loadExecutionAttempts(db, scene.intentId);
    expect(afterDispatch[0]?.state).toBe("UNKNOWN");
    expect(afterDispatch[0]?.spentBase).toBe(0n);

    // A blind retry: refused before anything reaches the venue, by the index
    // that counts UNKNOWN as live.
    const retry = await dispatchAttempt(scene.wiring, {
      intentId: scene.intentId,
      attempt: 2,
      instrument: scene.instrument,
      plan: planTerms(),
      quote: rawQuote(scene.instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(`${label}-retry`),
    });
    expect(retry.outcome).toBe("refused");
    if (retry.outcome === "refused") {
      expect(retry.refusal.reason.source).toBe("execution");
      // Specifically ATTEMPT_ALREADY_LIVE, not the generic PERSISTENCE_REFUSED:
      // #44's cancellation-chase driver has to tell "reconcile first, then
      // retry" apart from INTENT_ALREADY_CONSUMED ("never retry") and from an
      // ordinary write failure ("retry later"), and those three want opposite
      // responses. Flattening them into one code would make that undecidable
      // without parsing a detail string.
      expect(retry.refusal.reason.code).toBe("ATTEMPT_ALREADY_LIVE");
    }
    expect(await loadExecutionAttempts(db, scene.intentId)).toHaveLength(1);

    // Reconciliation against the venue's own state is the only way out, and
    // the read is taken after the dispatch it resolves.
    const later = instant("2026-03-01T12:00:05.000Z");
    const resolved = await reconcileAttempt(scene.wiring, {
      intentId: scene.intentId,
      attempt: 1,
      instrument: scene.instrument,
      order,
      now: later,
      ids: settlementIds(label),
      reconciliationId: `reconciliation-${label}-1`,
    });

    expect(resolved.outcome).toBe("recorded");
    if (resolved.outcome === "recorded") {
      expect(resolved.attemptState).toBe("ACKNOWLEDGED");
      // Nothing filled, so nothing is journaled and nothing is released.
      expect(resolved.journaledEntryIds).toEqual([]);
      expect(resolved.releasedBase).toBeNull();
    }

    const settledAttempts = await loadExecutionAttempts(db, scene.intentId);
    expect(settledAttempts[0]?.state).toBe("ACKNOWLEDGED");
    expect(settledAttempts[0]?.reconciliation?.reconciliationId).toBe(`reconciliation-${label}-1`);
  });
});

describe("a venue that refuses what the gate had already cleared", () => {
  it("leaves the attempt live and the dispatch enqueued, so a restart can see an outcome nobody knows", async () => {
    const label = "venuerefuse";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    // The venue charges 200bp of slippage; the injected cost model says 10.
    // So this application sizes and bounds `maxSpend` against one set of
    // numbers and the venue bills another — the exact divergence
    // `venue-economics.test.ts` guards against, here end to end. The gate
    // clears, because the gate uses this application's model, and the venue
    // then refuses the submission.
    const exchange = paperExchange({ slippageBasisPoints: 200 });
    const wiring = runtime(db, exchange);

    const authorized = await authorizeProposal(db, {
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

    const blocked = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      plan: planTerms(),
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(label),
    });

    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome !== "blocked") {
      return;
    }
    expect(blocked.stage).toBe("venue");
    expect(blocked.refusal.reason).toEqual({ source: "adapter", code: "MAX_SPEND_EXCEEDED" });
    // Not a policy decision, so nothing is recorded under a policy code.
    expect(blocked.reasonCode).toBeNull();

    // Deliberately NOT abandoned. The gate cleared and the venue disagreed,
    // which is an incident rather than a skip: marking the row `abandoned`
    // would hide an unresolved dispatch from every read that exists to find
    // one, while the attempt stayed live and blocked every retry.
    const dispatchRow = await loadDispatch(db, authorized.intentId, 1);
    expect(dispatchRow?.state).toBe("pending");
    expect(dispatchRow?.abandonmentReasonCode).toBeNull();
    expect(dispatchRow?.dispatchedAt).toBeNull();

    const unresolved = await loadUnresolvedDispatches(db);
    const mine = unresolved.find((row) => row.intentId === authorized.intentId);
    expect(mine).toBeDefined();
    expect(mine?.attemptState).toBe("SUBMITTING");
    expect(mine?.attemptLive).toBe(true);

    // And nothing filled: the venue holds no order under this id.
    const report = exchange.readVenueState({ now: NOW });
    expect([...report.openOrders, ...report.closedOrders]).toEqual([]);
  });
});

describe("partial exchange fill followed by cancellation", () => {
  it("persists the filled exposure and its actual costs, and releases only the confirmed unfilled remainder", async () => {
    const label = "partial";
    const scene = await scenario(label, {
      submission: { kind: "ACKNOWLEDGE" },
      // Four tenths of the order fills; the rest rests, and is what the
      // cancellation below actually cancels.
      executions: { kind: "STEPS", steps: [{ quantity: money("0.4000"), afterMs: 0 }] },
      cancellation: { kind: "CONFIRM" },
    });
    const order = await dispatch(scene, label);

    const polled = await pollAttempt(scene.wiring, {
      intentId: scene.intentId,
      attempt: 1,
      instrument: scene.instrument,
      order,
      now: NOW,
      ids: settlementIds(label),
    });
    expect(polled.outcome).toBe("recorded");
    if (polled.outcome !== "recorded") {
      return;
    }
    expect(polled.attemptState).toBe("PARTIALLY_FILLED");
    expect(polled.spentBase).toBeGreaterThan(0n);
    // A live partial fill is real exposure and is recorded on the attempt,
    // but it is not settled, so nothing is journaled and nothing released.
    expect(polled.journaledEntryIds).toEqual([]);
    expect(polled.releasedBase).toBeNull();
    expect(polled.settlement.releasableRemainder).toBeNull();

    const canceled = await cancelAttempt(scene.wiring, {
      intentId: scene.intentId,
      attempt: 1,
      instrument: scene.instrument,
      order: polled.order,
      now: NOW,
      ids: settlementIds(label),
    });
    expect(canceled.outcome).toBe("recorded");
    if (canceled.outcome !== "recorded") {
      return;
    }

    expect(canceled.attemptState).toBe("CANCELED");
    // The fill survived the cancellation, quantity and costs alike.
    expect(canceled.spentBase).toBe(polled.spentBase);
    expect(canceled.receivedBase).toBe(polled.receivedBase);
    expect(canceled.settlement.filledQuantity).toBe("0.4000");
    expect(canceled.settlement.releasableRemainder).toBe("0.6000");
    expect(canceled.settlement.residualExceedsPermitted).toBe(true);

    const stored = await loadApprovedIntent(db, scene.intentId);
    expect(stored).not.toBeNull();
    if (stored !== null) {
      // Only the part of the hold the fill did not consume comes back.
      expect(canceled.releasedBase).toBe(stored.input.maxSpendBase - canceled.spentBase);
      expect(canceled.releasedBase).toBeGreaterThan(0n);
    }

    const entries = await loadJournalEntries(db);
    const mine = entries.filter((entry) => entry.intentId === scene.intentId);
    // The hold, the trade, its costs, and the release of exactly what the
    // fill did not consume.
    expect(mine.map((entry) => entry.kind).toSorted()).toEqual([
      "fee",
      "reservation-hold",
      "reservation-release",
      "trade",
    ]);

    const attempts = await loadExecutionAttempts(db, scene.intentId);
    expect(attempts[0]?.state).toBe("CANCELED");
    expect(attempts[0]?.spentBase).toBe(canceled.spentBase);
  });
});

describe("a cancellation whose confirmation was lost", () => {
  it("leaves the order CANCEL_PENDING and releases nothing, because the quantity still working could yet fill", async () => {
    const label = "cancelto";
    const scene = await scenario(label, {
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "NONE" },
      cancellation: { kind: "TIMEOUT" },
    });
    const order = await dispatch(scene, label);

    const canceled = await cancelAttempt(scene.wiring, {
      intentId: scene.intentId,
      attempt: 1,
      instrument: scene.instrument,
      order,
      now: NOW,
      ids: settlementIds(label),
    });

    expect(canceled.outcome).toBe("recorded");
    if (canceled.outcome !== "recorded") {
      return;
    }
    expect(canceled.attemptState).toBe("CANCEL_PENDING");
    expect(canceled.releasedBase).toBeNull();
    expect(canceled.settlement.releasableRemainder).toBeNull();
    expect(canceled.journaledEntryIds).toEqual([]);

    // Durably visible as unresolved, which is what a cancellation-chase
    // driver consumes. This slice builds no retry, no timer, and no incident.
    const attempts = await loadExecutionAttempts(db, scene.intentId);
    expect(attempts[0]?.state).toBe("CANCEL_PENDING");
  });
});
