import { afterAll, describe, expect, it } from "vitest";

import { ACKNOWLEDGE_AND_FILL } from "@vigil/adapter-paper";
import {
  loadApprovedIntent,
  loadDispatch,
  loadExecutionAttempts,
  loadJournalEntries,
  loadBalances,
} from "@vigil/db";
import type { StoreApprovedIntent } from "@vigil/db";

import { authorizeProposal } from "./authorize";
import { clientOrderIdFor, dispatchAttempt } from "./dispatch";
import { pollAttempt } from "./settle";
import {
  MONEY_SCALE,
  NOW,
  capital,
  dispatchIds,
  fund,
  openExecutionTestDb,
  parsedQuote,
  planTerms,
  policyConfig,
  portfolio,
  proposal,
  rawQuote,
  runtime,
  settlementIds,
  syntheticInstrument,
  paperExchange,
  venueConfig,
} from "./test-support/execution-fixtures";

/**
 * The defects this file kills, end to end against the real schema:
 *
 *  * **One approved proposal authorizing two spends.** An at-least-once
 *    producer delivers the same proposal twice; the second delivery must find
 *    the authorization that already exists rather than mint a second one.
 *
 *  * **An authorization whose economics cannot be checked later.** The
 *    quote, the cost model, the notional, the gross, every cost component and
 *    the hurdle are written with the intent, because the market that made it
 *    worth doing is gone by the time the fill is judged.
 *
 *  * **A fill nobody can compare to what justified it.** The attempt carries
 *    the venue's confirmed spend and receipt; the intent carries what was
 *    expected. Either one alone measures luck.
 *
 *  * **Paying costs on a trade whose edge has evaporated.** An intent
 *    approved at one book, dispatched against another, must be refused before
 *    the venue is asked — and the refusal must be durable, under a reason
 *    code policy actually gave.
 *
 * The real-infrastructure fact every one of these needs is the migrated
 * schema: the unique indexes, the check constraints and the lifecycle
 * triggers are what answer them, and an in-memory store cannot.
 *
 * **No case truncates.** `journal_entries` and `approved_intents` are
 * append-only by trigger and the truncate list lives in `packages/db`'s own
 * test support, which is package-internal. Each case names its own synthetic
 * asset pair instead, so no two cases share an account key, a balance, or an
 * `asset_scales` row.
 */

const { db, close } = openExecutionTestDb("vigil-trading-execution-test");
afterAll(close);

const VENUE = venueConfig();

/** Enough of the quote asset to cover any envelope these cases build. */
const FUNDING_BASE = 1_000_000n;

async function authorizedIntent(label: string): Promise<{
  readonly intentId: string;
  readonly record: StoreApprovedIntent;
}> {
  const instrument = syntheticInstrument(label);
  await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

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
    throw new Error(`fixture proposal was refused: ${authorized.refusal.detail}`);
  }
  return { intentId: authorized.intentId, record: authorized.record };
}

describe("authorizeProposal", () => {
  it("authorizes one spend when the same proposal is delivered twice, and reports the second as the same authorization", async () => {
    const label = "dupe";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    const request = {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: policyConfig(),
      portfolio: portfolio(),
      capital: capital(),
    };

    const first = await authorizeProposal(db, request);
    // A second delivery of the SAME proposal under a different intent id:
    // the idempotency key is what makes them one authorization.
    const second = await authorizeProposal(db, {
      ...request,
      proposal: proposal(`${label}-again`, instrument, { idempotencyKey: `idem-${label}` }),
    });

    expect(first.outcome).toBe("authorized");
    expect(second.outcome).toBe("authorized");
    if (first.outcome === "authorized" && second.outcome === "authorized") {
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.intentId).toBe(first.intentId);
    }
    expect(await loadApprovedIntent(db, `intent-${label}-again`)).toBeNull();
  });

  it("stores the point-in-time economics the approval rested on, itemised by the basis the venue charges each cost on", async () => {
    const { intentId } = await authorizedIntent("econrec");
    const stored = await loadApprovedIntent(db, intentId);

    expect(stored).not.toBeNull();
    if (stored === null) {
      return;
    }

    const economics = stored.economics;
    expect(economics.costModelVersion).toBe(VENUE.costModelVersion);
    expect(stored.provenance.feeSnapshotVersion).toBe(VENUE.feeSnapshotVersion);
    expect(economics.netEdgeBasis).toBe("hurdle");
    expect(economics.expectedNetEdgeBase).toBe(economics.expectedGrossBase - economics.expectedTotalCostBase);

    const byKind = new Map(economics.costComponents.map((component) => [component.kind, component]));
    // Spread and slippage are inside the execution price; the fee and the
    // flat cost sit on top of it. Recording that distinction is what lets a
    // later comparison avoid subtracting an embedded cost twice.
    expect(byKind.get("spread")?.chargeBasis).toBe("embedded");
    expect(byKind.get("slippage-allowance")?.chargeBasis).toBe("embedded");
    expect(byKind.get("proportional-fee")?.chargeBasis).toBe("separately-charged");
    expect(byKind.get("fixed-costs")?.chargeBasis).toBe("separately-charged");

    const itemised = economics.costComponents.reduce((total, component) => total + component.numeraireAmountBase, 0n);
    expect(itemised).toBe(economics.expectedTotalCostBase);
    expect(economics.minimumNetEdgeBase).not.toBeNull();
    if (economics.minimumNetEdgeBase !== null) {
      expect(economics.expectedNetEdgeBase).toBeGreaterThanOrEqual(economics.minimumNetEdgeBase);
    }
  });

  it("refuses a gross-positive, net-negative small trade before anything is authorized at all, and writes no authorization", async () => {
    const label = "tinyskip";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    // The book is unchanged and the per-unit edge is the same 9.95 that
    // clears comfortably at a whole unit. Only the executable size is
    // different, and the flat 0.50 does not shrink with it.
    const refusedResult = await authorizeProposal(db, {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument, { askQuantity: "0.0050" }),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: policyConfig(),
      portfolio: portfolio(),
      capital: capital(),
    });

    expect(refusedResult.outcome).toBe("refused");
    if (refusedResult.outcome === "refused") {
      expect(refusedResult.refusal.reason).toEqual({ source: "policy", code: "INSUFFICIENT_NET_EDGE" });
    }
    expect(await loadApprovedIntent(db, `intent-${label}`)).toBeNull();
  });
});

describe("dispatchAttempt", () => {
  it("carries an approved intent through a simulated fill and records economics that can be compared to the approval's", async () => {
    const label = "fill";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    const exchange = paperExchange({ defaultBehavior: ACKNOWLEDGE_AND_FILL });
    const wiring = runtime(db, exchange);

    const authorized = await authorizeProposal(db, {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: wiring.policyConfig,
      portfolio: portfolio(),
      capital: capital(),
    });
    expect(authorized.outcome).toBe("authorized");
    if (authorized.outcome !== "authorized") {
      return;
    }

    const dispatched = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      plan: planTerms(),
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(label),
    });

    expect(dispatched.outcome).toBe("dispatched");
    if (dispatched.outcome !== "dispatched") {
      return;
    }
    expect(dispatched.persistence).toBeNull();
    expect(dispatched.attemptState).toBe("ACKNOWLEDGED");

    const settled = await pollAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      order: dispatched.order,
      now: NOW,
      ids: settlementIds(label),
    });

    expect(settled.outcome).toBe("recorded");
    if (settled.outcome !== "recorded") {
      return;
    }
    expect(settled.attemptState).toBe("FILLED");
    expect(settled.overspend).toBeNull();

    // Expected, from the authorization; actual, from the venue. The point of
    // the pair is that they can be held against each other at all.
    const stored = await loadApprovedIntent(db, authorized.intentId);
    expect(stored).not.toBeNull();
    if (stored !== null) {
      // A complete fill consumes exactly the envelope the approval bounded.
      expect(settled.spentBase).toBe(stored.input.maxSpendBase);
      expect(settled.receivedBase).toBe(stored.output.quantityBase);
      // Nothing to hand back, so no release posting exists to hand it back.
      expect(settled.releasedBase).toBeNull();
    }

    const attempts = await loadExecutionAttempts(db, authorized.intentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("FILLED");
    expect(attempts[0]?.clientOrderId).toBe(clientOrderIdFor(`idem-${label}`, 1));
    expect(attempts[0]?.spentBase).toBe(settled.spentBase);

    const dispatch = await loadDispatch(db, authorized.intentId, 1);
    expect(dispatch?.state).toBe("dispatched");
    expect(dispatch?.payloadDigest).toMatch(/^[0-9a-f]{64}$/u);

    // Everything this authorization moved, in the ledger: the hold that
    // `docs/resilience.md` §9 requires before submission, the trade, and its
    // separately charged costs. Nothing claiming to be realized P&L, and no
    // release — a complete fill consumed the whole hold.
    const entries = await loadJournalEntries(db);
    const mine = entries.filter((entry) => entry.intentId === authorized.intentId);
    expect(mine.map((entry) => entry.kind).toSorted()).toEqual(["fee", "reservation-hold", "trade"]);

    const balances = await loadBalances(db);
    const reserved = balances.find(
      (balance) => balance.assetId === instrument.quoteAssetId && balance.holdingsState === "reserved",
    );
    // Held, then spent: the hold and the spend cancel exactly.
    expect(reserved === undefined ? 0n : reserved.debitBase - reserved.creditBase).toBe(0n);
  });

  it("blocks a dispatch whose edge decayed after approval, records the reason code, and asks the venue nothing", async () => {
    const label = "decay";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    const exchange = paperExchange({ defaultBehavior: ACKNOWLEDGE_AND_FILL });
    const wiring = runtime(db, exchange);

    const authorized = await authorizeProposal(db, {
      proposal: proposal(label, instrument),
      quote: parsedQuote(instrument),
      now: NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: wiring.policyConfig,
      portfolio: portfolio(),
      capital: capital(),
    });
    expect(authorized.outcome).toBe("authorized");
    if (authorized.outcome !== "authorized") {
      return;
    }

    // Approved against 250.00 / 250.10; dispatched against 257.50 / 257.60,
    // where the same thesis target leaves 0.99 of net edge against a 1.00
    // hurdle. Nothing about the authorization changed.
    const blocked = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      plan: planTerms(),
      quote: rawQuote(instrument, { bidPrice: "257.50", askPrice: "257.60" }),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(label),
    });

    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome !== "blocked") {
      return;
    }
    expect(blocked.stage).toBe("netEdge");
    expect(blocked.refusal.reason).toEqual({ source: "policy", code: "INSUFFICIENT_NET_EDGE" });
    // The code the caller records; this domain writes no decision of its own.
    expect(blocked.reasonCode).toBe("INSUFFICIENT_NET_EDGE");
    expect(blocked.persistence).toBeNull();
    expect(blocked.attemptId).toBeNull();
    expect(blocked.dispatchId).toBeNull();

    // NOTHING durable was written. This is the defect that matters: a skip is
    // the gate's designed-for common case, and an attempt row or a hold left
    // behind here would strand the authorization and its capital for good —
    // the attempt live-forever under `execution_attempts_intent_id_live_key`,
    // the hold unreleasable because a release needs a settled attempt that
    // actually spent something.
    expect(await loadExecutionAttempts(db, authorized.intentId)).toEqual([]);
    expect(await loadDispatch(db, authorized.intentId, 1)).toBeNull();
    const reservedAfterBlock = (await loadBalances(db)).find(
      (balance) => balance.assetId === instrument.quoteAssetId && balance.holdingsState === "reserved",
    );
    expect(reservedAfterBlock === undefined ? 0n : reservedAfterBlock.debitBase - reservedAfterBlock.creditBase).toBe(
      0n,
    );

    // The venue was never asked, so it holds nothing under this id.
    const report = exchange.readVenueState({ now: NOW });
    expect([...report.openOrders, ...report.closedOrders]).toEqual([]);

    // And the authorization is still exactly as usable as it was: the same
    // intent, the same attempt number, dispatched against a quote whose edge
    // still clears.
    const retried = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      plan: planTerms(),
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(label),
    });
    expect(retried.outcome).toBe("dispatched");
    if (retried.outcome === "dispatched") {
      expect(retried.attemptState).toBe("ACKNOWLEDGED");
    }
  });

  it("completes the journal when a settlement is redelivered, rather than refusing the replay its idempotency keys exist for", async () => {
    const label = "resettle";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label);

    const exchange = paperExchange({ defaultBehavior: ACKNOWLEDGE_AND_FILL });
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
    const dispatched = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      plan: planTerms(),
      quote: rawQuote(instrument),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds(label),
    });
    if (dispatched.outcome !== "dispatched") {
      return;
    }

    const settle = {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      order: dispatched.order,
      now: NOW,
      ids: settlementIds(label),
    } as const;

    const first = await pollAttempt(wiring, settle);
    expect(first.outcome).toBe("recorded");

    // The attempt is now FILLED, and `execution_attempts_terminal_is_final`
    // fires on ANY update of a settled attempt — including one that changes
    // nothing. An at-least-once caller redelivering must still succeed, and,
    // far more importantly, a crash part-way through the postings must be
    // able to finish them: they are written in separate transactions and only
    // a re-run can complete a partial journal.
    // Replayed with the order the caller HELD, not the settled one it got
    // back — which is the shape a real replay takes, because the process that
    // crashed never saw the settled order. Polling the settled order itself
    // is refused by the adapter (`ORDER_ALREADY_TERMINAL`) long before the
    // database is touched, so it is not the case that matters here.
    const second = await pollAttempt(wiring, settle);
    expect(second.outcome).toBe("recorded");
    if (second.outcome === "recorded" && first.outcome === "recorded") {
      expect(second.spentBase).toBe(first.spentBase);
      expect(second.receivedBase).toBe(first.receivedBase);
      // Re-posted under the same keys, so the journal is complete and not
      // doubled.
      expect(second.journaledEntryIds).toEqual(first.journaledEntryIds);
    }

    const entries = (await loadJournalEntries(db)).filter((entry) => entry.intentId === authorized.intentId);
    expect(entries.map((entry) => entry.kind).toSorted()).toEqual(["fee", "reservation-hold", "trade"]);
  });

  it("refuses to dispatch an intent that is not in durable history", async () => {
    const wiring = runtime(db, paperExchange());
    const result = await dispatchAttempt(wiring, {
      intentId: "intent-that-was-never-approved",
      attempt: 1,
      instrument: syntheticInstrument("ghost"),
      plan: planTerms(),
      quote: rawQuote(syntheticInstrument("ghost")),
      now: NOW,
      portfolio: portfolio(),
      ids: dispatchIds("ghost"),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason).toEqual({ source: "execution", code: "UNKNOWN_INTENT" });
    }
  });
});
