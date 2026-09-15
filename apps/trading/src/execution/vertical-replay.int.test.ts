import { afterAll, describe, expect, it } from "vitest";

import { ACKNOWLEDGE_AND_FILL } from "@vigil/adapter-paper";
import type { IsoUtcTimestamp } from "@vigil/contracts";
import {
  loadApprovedIntent,
  loadBalances,
  loadCandidates,
  loadJournalEntries,
  loadPositionPlan,
  recordCandidate,
  recordCandidateEvaluation,
  reservations,
} from "@vigil/db";
import type { StoreCandidate, StoreCandidateEvaluation, StoredBalance, VigilDatabase } from "@vigil/db";
import { quoteSnapshotSchema } from "@vigil/market";
import type { QuoteSnapshot } from "@vigil/market";
import { addDecimal, evaluateEntry, subtractDecimal } from "@vigil/strategies";
import type { Candidate, EntryEvaluationRecord } from "@vigil/strategies";

import { authorizeProposal } from "./authorize";
import type { TradeProposal } from "./authorize";
import { dispatchAttempt } from "./dispatch";
import type { Instrument } from "./position-plan";
import { pollAttempt } from "./settle";
import {
  MONEY_SCALE,
  capital,
  dispatchIds,
  exposureCap,
  fund,
  instant,
  money,
  openExecutionTestDb,
  paperExchange,
  policyConfig,
  portfolio,
  runtime,
  settlementIds,
  syntheticInstrument,
  venueConfig,
} from "./test-support/execution-fixtures";
import {
  ENTRY_NOW,
  ENTRY_QUOTE,
  FORMATION_NOW,
  FORMATION_QUOTE,
  formReplayCandidate,
  replayQuote,
} from "./test-support/replay-scenario";
import type { SyntheticMarketFixtureQuote } from "./test-support/replay-scenario";

/**
 * vertical-replay.int.test.ts — BOOT-08's one deterministic PAPER replay:
 * a recorded synthetic quote path carried through the strategy's own
 * candidate and entry check, the policy-checked authorization, the capital
 * reservation, a paper fill, settlement, and the durable journal, balance,
 * reservation and candidate state the operator dashboard reads back.
 *
 * ```text
 *   BOOT-03 recorded quote  ->  generateCandidate     (@vigil/strategies)
 *                           ->  evaluateEntry          (the no-chasing check)
 *                           ->  recordCandidate / recordCandidateEvaluation
 *                           ->  authorizeProposal      (policy gate + durable intent + plan)
 *                           ->  dispatchAttempt        (revalidate -> reserve -> paper submit)
 *                           ->  pollAttempt            (settle -> journal -> hold consumed)
 *                           ->  loadBalances / loadJournalEntries /
 *                               loadCandidates / reservations
 * ```
 *
 * ## Why this file lives beside apps/trading
 *
 * The replay drives `@vigil/adapter-paper`, and the layer graph lets only
 * `apps/trading` import an `adapter-*` package (`docs/architecture.md`,
 * "Layer graph and import rules"; `eslint.config.mjs` zone 2). It is an
 * `*.int.test.ts` because the properties it asserts are the migrated
 * schema's: the unique indexes, the append-only journal triggers and the
 * reservation lifecycle. Moving it under `tests/replay/` would require
 * weakening that boundary, which #11 puts explicitly out of scope.
 *
 * ## What this file deliberately does NOT re-test
 *
 * It composes existing coverage rather than restating it. Each claim below
 * is owned elsewhere and is cited, not cloned:
 *
 *  * duplicate proposal delivery, the stored point-in-time economics, the
 *    pre-dispatch net-edge decay refusal and replayed-settlement
 *    idempotency — `execution-path.int.test.ts`;
 *  * crash/timeout after venue acceptance -> `UNKNOWN` -> reconciliation
 *    with no blind retry, and partial fill then cancellation —
 *    `execution-faults.int.test.ts`;
 *  * a stale or corrupt quote blocking new risk — `packages/market/src/freshness.test.ts`;
 *  * the reservation state machine and the expiry sweep —
 *    `expiry.int.test.ts`, `restart-revalidation.int.test.ts`;
 *  * the full `evaluateEntry` decision table and `generateCandidate`'s own
 *    determinism — `packages/strategies/src/no-chasing.test.ts` and
 *    `candidate.test.ts`;
 *  * that the recorded fixture below is exactly what the synthetic feed
 *    produces — `tests/replay/synthetic-market.test.ts`;
 *  * journal replay/rebuild — `tests/replay/journal-rebuild.int.test.ts`.
 *
 * ## The seam this replay proves, and the seam it cannot
 *
 * Read this before treating a green run as proof the bootstrap slice is
 * wired together.
 *
 * No module in `apps/trading` composes `@vigil/strategies` with the
 * execution domain today: `main.ts` starts the heartbeat loop and the
 * reservation expiry sweep and nothing else, and `generateCandidate` /
 * `evaluateEntry` have no production call site anywhere in the workspace.
 * So `proposalFromCandidate` and `storeCandidateFrom` below are written
 * HERE, by this test, and they are the only thing standing between the two
 * halves.
 *
 * What that means honestly:
 *
 *  * **Proved.** The two halves' contracts compose. A `Candidate`'s
 *    instrument id, entry zone, staged tranches, horizon, outcome
 *    vocabulary and derived ids are accepted, unchanged, by
 *    `packages/db`'s decision family and by `authorizeProposal`; the
 *    venue's executable liquidity from the recorded quote is what sizes
 *    the trade; and the candidate's own entry zone is the band the policy
 *    gate measures the executable price against, at approval and again at
 *    dispatch.
 *  * **Not proved.** That a running `apps/trading` performs this
 *    composition. There is no such driver, and a replay cannot invent one.
 *    Report this suite as evidence that the bootstrap slice's pieces fit,
 *    never as evidence that the runtime runs the path end to end.
 *
 * Two values the translation has to supply because no record carries them
 * are named where they are built: the thesis exit price (a `Candidate`
 * carries an entry zone and an invalidation price, not an exit target) and
 * the policy/portfolio provenance versions.
 *
 * ## The scenario's premise is guarded next door
 *
 * `vertical-replay-premise.test.ts` pins the recorded prices, instants and
 * quantity this file's arithmetic was derived from, and re-derives the entry
 * zone from them. It is a pure `*.test.ts` on purpose: the `integration` job
 * is not selected for `tests/fixtures/*` or `packages/strategies/*`, which
 * are the two paths a change invalidating that premise would touch, so a
 * guard living in here would never run on the change it exists to catch.
 *
 * Both files take the quotes, the injected instants, the strategy config and
 * the candidate formation from `test-support/replay-scenario.ts`, so the
 * guard cannot drift into checking values this replay no longer uses.
 *
 * ## Terminal record
 *
 * The terminal state asserted here is the existing candidate evaluation
 * plus the execution/journal/balance records. The future `outcomes` family
 * is NEXT-04's and is neither built nor written to (#11, scope item 6).
 *
 * ## Determinism
 *
 * Every id and instant is injected, the market input is the recorded
 * BOOT-03 fixture, and the paper exchange carries a fixed seed, so the same
 * logical scenario writes the same rows under the same keys on every run —
 * including the candidate and evaluation primary keys, which the strategy
 * derives from the quote rather than inventing. Cross-run determinism of
 * the market input itself is `tests/replay/synthetic-market.test.ts`'s
 * claim, not restated here.
 *
 * ## Isolation, and PAPER only
 *
 * Each case names its own synthetic asset pair, for the reason
 * `test-support/execution-fixtures.ts` documents: the integration database
 * is shared and cannot be truncated from here, so per-case assets give
 * every case its own account keys, `asset_scales` rows and balances.
 * Chain `1337` and `SYNTHETIC_TESTNET` are this repository's synthetic
 * identifiers; no address, key, holding, credential, live endpoint or
 * signer appears, and the only adapter is the paper one.
 */

const { db, close } = openExecutionTestDb("vigil-trading-vertical-replay-test");
afterAll(close);

const VENUE = venueConfig();
const POLICY = policyConfig();

/** Provenance this replay states for itself; no production driver supplies one yet. */
const POLICY_VERSION = "policy-vertical-replay-0";
const PORTFOLIO_SNAPSHOT_VERSION = "portfolio-vertical-replay-0";

/**
 * 100,000.00 of the quote asset. Deliberately far above anything these
 * cases spend: the point of the counter-case below is that the money is
 * genuinely there and genuinely reservable, so the guard — not an empty
 * account — is what stops the chase.
 */
const FUNDING_BASE = 10_000_000n;

/** Well after every instant in this replay; bounds the intent and its hold. */
const VALID_UNTIL = instant("2024-01-01T01:00:00.000Z");

/**
 * When the synthetic capital arrived: the recording's own first instant,
 * before anything this replay does. `fund`'s default sits on the fixtures'
 * 2026-03-01 clock, which against this recording would date the deposit two
 * years after the trade it pays for.
 */
const CAPITAL_FUNDED_AT = instant("2024-01-01T00:00:00.000Z");

/**
 * Reconciled four minutes before the formation quote — inside
 * `maxReconciliationAgeMs` at both instants this replay evaluates at.
 *
 * Stated here rather than taken from the shared `RECONCILED` fixture on
 * purpose: that one is anchored to 2026-03-01, and against this recording's
 * 2024-01-01 clock it is future-dated, which `checkAccountReconciled`
 * correctly refuses as corrupt provenance rather than treating as unusually
 * fresh.
 */
const RECONCILED_AT_REPLAY_CLOCK = {
  reconciledThrough: instant("2024-01-01T00:04:00.000Z"),
  unresolvedDiscrepancyCount: 0,
} as const;

/**
 * Capital and caps wide enough that the venue's executable liquidity is the
 * binding sizing bound. That is the point rather than a convenience: with
 * liquidity binding, the sized quantity IS the recorded quote's
 * `askQuantity`, so the size this replay trades is derived from the market
 * fixture instead of from an arithmetic result a test would have to
 * hand-compute. Every case asserts that the liquidity bound is the one that
 * bound it, so a change that let some other bound win fails loudly here
 * rather than silently trading a different size.
 */
const REPLAY_CAPITAL = capital({
  fundsAvailableQuote: money("100000.00"),
  adverseLossBudgetQuote: money("10000.00"),
});
const REPLAY_PORTFOLIO = portfolio({
  account: RECONCILED_AT_REPLAY_CLOCK,
  exposureCaps: [exposureCap({ capQuote: money("100000.00") })],
});

/**
 * The five recorded values this file's own assertions are derived from: the
 * two asks that fix every execution price below, the quantity the trade is
 * sized to, and the two instants the injected clock sits one second after.
 *
 * The full premise — including the entry zone re-derived from the formation
 * ask — is `vertical-replay-premise.test.ts`, which runs under `unit tests`
 * and so is actually selected when the fixture or the strategy changes. This
 * is the short version, here only so a drifted fixture fails on the value
 * that drifted rather than deep inside a settlement assertion.
 */
function assertScenarioInputs(): void {
  expect(FORMATION_QUOTE.askPrice).toBe("250.96");
  expect(FORMATION_QUOTE.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:05:00.000Z");
  expect(ENTRY_QUOTE.askPrice).toBe("249.61");
  expect(ENTRY_QUOTE.askQuantity).toBe("48.6798");
  expect(ENTRY_QUOTE.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:08:00.000Z");
}

function parsedQuoteFor(instrument: Instrument, recorded: SyntheticMarketFixtureQuote): QuoteSnapshot {
  return quoteSnapshotSchema.parse(replayQuote(instrument, recorded));
}

/**
 * The candidate, formed through the shared scenario so this file and the
 * premise guard cannot form it differently. A recording that no longer
 * produces one fails here rather than several assertions later.
 */
function candidateFrom(
  instrument: Instrument,
  recorded: SyntheticMarketFixtureQuote,
  now: IsoUtcTimestamp,
): Candidate {
  const generated = formReplayCandidate(instrument, recorded, now);
  if (generated.outcome !== "candidate") {
    throw new Error(
      `the recorded quote produced no candidate (${generated.outcome}); this replay's premise no longer holds`,
    );
  }
  return generated.candidate;
}

/**
 * `Candidate` -> `candidates` + `candidate_tranches`.
 *
 * Every field is carried straight across; nothing is re-derived. The two
 * provenance versions the candidate does not carry are this replay's own
 * (see the module header), and the market snapshot version is the quote's
 * acquisition instant, which is the only thing that actually identifies
 * the snapshot this decision was made on.
 */
function storeCandidateFrom(candidate: Candidate, recordedAt: string): StoreCandidate {
  return {
    candidateId: candidate.candidateId,
    idempotencyKey: candidate.idempotencyKey,
    correlationId: candidate.correlationId,
    strategyId: candidate.strategyId,
    instrumentId: candidate.instrumentId,
    action: candidate.action,
    actionDetail: candidate.actionDetail,
    horizon: candidate.horizon,
    entryZoneMin: candidate.entryZone.min,
    entryZoneMax: candidate.entryZone.max,
    allowedExtension: candidate.allowedExtension,
    invalidationPrice: candidate.invalidationPrice,
    invalidationConditions: candidate.invalidationConditions,
    expiresAt: candidate.expiresAt,
    benchmarkId: candidate.benchmarkId,
    marketSnapshot: candidate.marketSnapshot,
    generatedAt: candidate.generatedAt,
    recordedAt,
    provenance: {
      policyVersion: POLICY_VERSION,
      strategyVersion: candidate.strategyVersion,
      modelVersion: null,
      portfolioSnapshotVersion: PORTFOLIO_SNAPSHOT_VERSION,
      marketSnapshotVersion: `market-${candidate.marketSnapshot.quoteAcquiredAt}`,
    },
    tranches: candidate.positionPlan.tranches.map((tranche) => ({
      index: tranche.index,
      quantity: tranche.quantity,
      triggerPrice: tranche.triggerPrice,
    })),
  };
}

/**
 * `EntryEvaluationRecord` -> `candidate_evaluations`.
 *
 * No mapping table and no cast: `@vigil/strategies`' outcome vocabulary and
 * `packages/db`'s `candidate_outcome` enum are the same four values, and
 * `recordCandidateEvaluation` re-checks both the outcome and the reason
 * code against the registry at the boundary. A drift between the two
 * vocabularies fails here.
 */
function storeEvaluationFrom(evaluation: EntryEvaluationRecord, recordedAt: string): StoreCandidateEvaluation {
  return {
    evaluationId: evaluation.evaluationId,
    idempotencyKey: evaluation.idempotencyKey,
    candidateId: evaluation.candidateId,
    outcome: evaluation.outcome,
    reasonCode: evaluation.reasonCode,
    detail: evaluation.detail,
    executablePrice: evaluation.executablePrice,
    quoteAcquiredAt: evaluation.quoteAcquiredAt,
    evaluatedAt: evaluation.evaluatedAt,
    recordedAt,
  };
}

/**
 * `Candidate` -> `TradeProposal`: the translation no production module owns.
 *
 * The load-bearing line is `entryZone: candidate.entryZone`: the zone is
 * carried across unchanged, never re-derived from the price being authorized
 * against.
 *
 * A translation that DID re-derive it — the obvious bad implementation — is
 * caught by the ELIGIBLE case below, not by the chasing one. Re-derived from
 * the entry quote, the same rule gives [247.61, 249.11], and that dispatch's
 * executable price of 249.86 sits above it: the authorization refuses and
 * `expect(authorized.outcome).toBe("authorized")` fails. The stored plan's
 * terms are asserted against the candidate's own bounds for the same reason,
 * so the zone's identity is pinned and not merely its effect.
 *
 * That mutation is structurally invisible to any chasing case built on this
 * strategy, which is worth stating so nobody adds one expecting it to help.
 * `generateCandidate` sets `max = ask - pullback` with a strictly positive
 * pullback, and a BUY's executable price is the ask moved UP by the venue's
 * slippage cap. So for EVERY quote Q, a zone re-derived from Q has a maximum
 * strictly below Q's own executable price, and the gate refuses whichever
 * zone it was handed. A refusal there discriminates nothing.
 *
 * `thesis.expectedExitPriceQuote` has to be invented, because a `Candidate`
 * carries an entry zone and an invalidation price but no exit target. It is
 * derived from the candidate's own numbers at a stated 2:1 reward-to-risk —
 * `entryZone.max + 2 * (entryZone.min - invalidationPrice)` — rather than
 * pinned to a literal, so it moves with the candidate instead of silently
 * becoming a figure the strategy never implied. Mature exit/outcome
 * modelling is NEXT-04's, not this replay's.
 */
function proposalFromCandidate(
  candidate: Candidate,
  instrument: Instrument,
  label: string,
  quoteAcquiredAt: string,
): TradeProposal {
  const riskPerUnit = subtractDecimal(candidate.entryZone.min, candidate.invalidationPrice);
  const expectedExitPriceQuote = addDecimal(candidate.entryZone.max, addDecimal(riskPerUnit, riskPerUnit));

  return {
    intentId: `intent-${label}`,
    idempotencyKey: `idem-${label}`,
    // The candidate's own correlation id, so the intent, the hold, the
    // attempt and every posting thread back to the decision that produced
    // them — which is what the dashboard's audit trail groups on.
    correlationId: candidate.correlationId,
    economicActionId: `action-${label}`,
    positionPlanId: `plan-${label}`,
    candidateId: candidate.candidateId,
    fundingAccountId: "account-synthetic",
    action: candidate.action,
    baseAssetId: instrument.baseAssetId,
    quoteAssetId: instrument.quoteAssetId,
    entryZone: candidate.entryZone,
    thesis: { expectedExitPriceQuote },
    minAcceptableReceiptQuantity: money("0.0001"),
    permittedResidualQuote: money("1.00"),
    validUntil: VALID_UNTIL,
    requiredFreshnessMs: POLICY.maxQuoteAgeMs,
    protectionPlan: null,
    remainingInventoryTreatment: "leave-as-is",
    benchmarkId: candidate.benchmarkId,
    approvalReason: `${candidate.actionDetail} from candidate ${candidate.candidateId}`,
    quoteId: `quote-${quoteAcquiredAt}`,
    provenance: {
      policyVersion: POLICY_VERSION,
      strategyVersion: candidate.strategyVersion,
      modelVersion: null,
      portfolioSnapshotVersion: PORTFOLIO_SNAPSHOT_VERSION,
      marketSnapshotVersion: `market-${quoteAcquiredAt}`,
    },
  };
}

/** Net movement of one asset in one holdings state, as `loadBalances` reports it. */
function netHoldings(balances: readonly StoredBalance[], assetId: string, state: string): bigint {
  return balances
    .filter((balance) => balance.assetId === assetId && balance.holdingsState === state)
    .reduce((net, balance) => net + balance.debitBase - balance.creditBase, 0n);
}

/**
 * Every reservation row for one intent, read the way the dashboard reads
 * them: straight off the `reservations` table `@vigil/db` exports, filtered
 * in application code. `apps/control/src/lib/data.ts` does exactly this
 * because `loadActiveReservations` answers one asset at a time and returns
 * three fields; #25 tracks turning the dashboard's read into a store
 * function, and this test deliberately mirrors today's read rather than
 * asserting against a shape the dashboard does not use.
 */
async function reservationRowsFor(database: VigilDatabase, intentId: string) {
  const rows = await database.select().from(reservations);
  return rows.filter((row) => row.intentId === intentId);
}

describe("the vertical PAPER replay (composed by this test; apps/trading wires no such driver)", () => {
  it("carries one recorded pullback from strategy candidate to settled journal, balance, reservation and candidate state", async () => {
    assertScenarioInputs();

    const label = "vertfill";
    const instrument = syntheticInstrument(label);
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label, CAPITAL_FUNDED_AT);

    // ---- 1. the synthetic market becomes a candidate ----------------------
    const candidate = candidateFrom(instrument, FORMATION_QUOTE, FORMATION_NOW);
    const recordedCandidate = await recordCandidate(db, storeCandidateFrom(candidate, FORMATION_NOW));
    expect(recordedCandidate.outcome).toBe("recorded");
    // Keyed by the id the STRATEGY derived from the quote, not by one the
    // test invented: that is what makes a re-run of the same synthetic
    // input write the same row instead of a second one.
    if (recordedCandidate.outcome !== "refused") {
      expect(recordedCandidate.candidateId).toBe(candidate.candidateId);
    }

    // ---- 2. the current-entry check admits the later quote ----------------
    const entry = evaluateEntry({
      candidate,
      quote: replayQuote(instrument, ENTRY_QUOTE),
      now: ENTRY_NOW,
      maxQuoteAgeMs: POLICY.maxQuoteAgeMs,
    });
    expect(entry.evaluation.outcome).toBe("ENTRY_ELIGIBLE");
    // Eligible is not a rejection, so it carries no reason code — and the
    // price it decided on is the recorded ask, not a re-derived one.
    expect(entry.evaluation.reasonCode).toBeNull();
    expect(entry.evaluation.executablePrice).toBe(ENTRY_QUOTE.askPrice);
    // The decision names the candidate it was made about, which is the
    // thread the intent, the holds and the postings below all follow.
    expect(entry.evaluation.candidateId).toBe(candidate.candidateId);

    const recordedEvaluation = await recordCandidateEvaluation(
      db,
      storeEvaluationFrom(entry.evaluation, ENTRY_NOW),
    );
    expect(recordedEvaluation.outcome).toBe("recorded");

    // ---- 3. authorization, against the candidate's own zone --------------
    const proposal = proposalFromCandidate(candidate, instrument, label, ENTRY_QUOTE.timestamps.quoteAcquiredAt);
    const authorized = await authorizeProposal(db, {
      proposal,
      quote: parsedQuoteFor(instrument, ENTRY_QUOTE),
      now: ENTRY_NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: POLICY,
      portfolio: REPLAY_PORTFOLIO,
      capital: REPLAY_CAPITAL,
    });

    expect(authorized.outcome).toBe("authorized");
    if (authorized.outcome !== "authorized") {
      return;
    }
    expect(authorized.duplicate).toBe(false);
    expect(authorized.side).toBe("BUY");

    // The size came from the recorded quote's top-of-book liquidity, and
    // the assertion says so twice: the bound that bound it, and the number
    // itself. Without the first, a change that let funds or the exposure
    // cap bind would quietly trade a different size and the second
    // assertion would be the only thing to notice.
    expect(authorized.evaluation.size.breakdown.bindingBounds).toEqual(["executableLiquidity"]);
    expect(authorized.evaluation.size.quantityBase).toBe(ENTRY_QUOTE.askQuantity);

    // The terms the dispatch gate will re-read are the CANDIDATE's terms,
    // durably, under the id the intent names.
    const storedPlan = await loadPositionPlan(db, proposal.positionPlanId);
    expect(storedPlan).not.toBeNull();
    expect(storedPlan?.entryZoneMin).toBe(candidate.entryZone.min);
    expect(storedPlan?.entryZoneMax).toBe(candidate.entryZone.max);
    expect(storedPlan?.instrumentId).toBe(candidate.instrumentId);

    const stored = await loadApprovedIntent(db, authorized.intentId);
    expect(stored).not.toBeNull();
    if (stored === null) {
      return;
    }
    expect(stored.candidateId).toBe(candidate.candidateId);
    expect(stored.operatingMode).toBe("PAPER");

    // ---- 4. dispatch: revalidate, hold capital, reach the paper venue ----
    const exchange = paperExchange({ defaultBehavior: ACKNOWLEDGE_AND_FILL });
    const wiring = runtime(db, exchange, { venue: VENUE, policyConfig: POLICY });

    const dispatched = await dispatchAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      quote: replayQuote(instrument, ENTRY_QUOTE),
      now: ENTRY_NOW,
      portfolio: REPLAY_PORTFOLIO,
      ids: dispatchIds(label),
    });

    expect(dispatched.outcome).toBe("dispatched");
    if (dispatched.outcome !== "dispatched") {
      return;
    }
    expect(dispatched.attemptState).toBe("ACKNOWLEDGED");
    expect(dispatched.persistence).toBeNull();

    // The hold exists and is ACTIVE before anything settles — the state the
    // dashboard's Reservations panel shows while an order is live. Observing
    // it here is what makes its absence after settlement mean something:
    // a row that was never written would satisfy the later assertion just
    // as well.
    const heldRows = await reservationRowsFor(db, authorized.intentId);
    expect(heldRows).toHaveLength(1);
    const held = heldRows[0];
    expect(held?.state).toBe("active");
    expect(held?.amountBase).toBe(stored.input.maxSpendBase);
    expect(held?.assetId).toBe(instrument.quoteAssetId);
    expect(held?.correlationId).toBe(candidate.correlationId);

    const heldBalances = await loadBalances(db);
    expect(netHoldings(heldBalances, instrument.quoteAssetId, "reserved")).toBe(stored.input.maxSpendBase);
    expect(netHoldings(heldBalances, instrument.quoteAssetId, "available")).toBe(
      FUNDING_BASE - stored.input.maxSpendBase,
    );

    // ---- 5. settlement ---------------------------------------------------
    const settled = await pollAttempt(wiring, {
      intentId: authorized.intentId,
      attempt: 1,
      instrument,
      order: dispatched.order,
      now: ENTRY_NOW,
      ids: settlementIds(label),
    });

    expect(settled.outcome).toBe("recorded");
    if (settled.outcome !== "recorded") {
      return;
    }
    expect(settled.attemptState).toBe("FILLED");
    expect(settled.overspend).toBeNull();
    // A complete fill consumes exactly the envelope the approval bounded and
    // delivers exactly the quantity it sized, so there is nothing to release.
    expect(settled.spentBase).toBe(stored.input.maxSpendBase);
    expect(settled.receivedBase).toBe(stored.output.quantityBase);
    expect(settled.releasedBase).toBeNull();
    expect(settled.reservationState).toBe("consumed");
    expect(settled.reservationRefusal).toBeNull();

    // ---- 6. the terminal state the operator surfaces read ---------------
    const entries = (await loadJournalEntries(db)).filter((posting) => posting.intentId === authorized.intentId);
    // The COMPLETE entry set for this intent, not a sample of it: the hold
    // `docs/resilience.md` §9 requires before submission, the trade, and the
    // separately charged costs. Nothing claiming realized P&L, and no
    // release, because the whole hold was spent.
    expect(entries.map((posting) => posting.kind).toSorted()).toEqual(["fee", "reservation-hold", "trade"]);
    expect(entries.every((posting) => posting.correlationId === candidate.correlationId)).toBe(true);

    const balances = await loadBalances(db);
    // The money identity across that whole entry set. Every base unit is
    // accounted for: what was funded, less exactly what was spent, is what
    // remains available; the hold nets to zero because it was consumed
    // rather than released; and the base asset the operator now holds is
    // exactly the quantity the authorization sized.
    expect(netHoldings(balances, instrument.quoteAssetId, "available")).toBe(FUNDING_BASE - settled.spentBase);
    expect(netHoldings(balances, instrument.quoteAssetId, "reserved")).toBe(0n);
    expect(netHoldings(balances, instrument.baseAssetId, "available")).toBe(stored.output.quantityBase);

    const settledRows = await reservationRowsFor(db, authorized.intentId);
    expect(settledRows).toHaveLength(1);
    expect(settledRows[0]?.state).toBe("consumed");

    // The decision the dashboard's Candidates panel renders, still pointing
    // at the entry this replay actually took, under the strategy's own
    // derived evaluation id.
    const durableCandidate = (await loadCandidates(db)).find(
      (row) => row.candidateId === candidate.candidateId,
    );
    expect(durableCandidate?.instrumentId).toBe(candidate.instrumentId);
    expect(durableCandidate?.entryZoneMin).toBe(candidate.entryZone.min);
    expect(durableCandidate?.entryZoneMax).toBe(candidate.entryZone.max);
    expect(durableCandidate?.expiresAt).toBe(candidate.expiresAt);
    expect(durableCandidate?.latestEvaluation?.evaluationId).toBe(entry.evaluation.evaluationId);
    expect(durableCandidate?.latestEvaluation?.outcome).toBe("ENTRY_ELIGIBLE");
    expect(durableCandidate?.latestEvaluation?.reasonCode).toBeNull();
    expect(durableCandidate?.latestEvaluation?.evaluatedAt).toBe(ENTRY_NOW);
    // The staged plan survived the round trip through two tables.
    expect(durableCandidate?.tranches.map((tranche) => tranche.triggerPrice)).toEqual([
      "250.46",
      "249.71",
      "248.96",
    ]);
  });

  it("refuses to authorize the same candidate at the price that formed it, and leaves nothing durable behind", async () => {
    assertScenarioInputs();

    const label = "vertchase";
    const instrument = syntheticInstrument(label);
    // Funded, so the spend this case forbids is genuinely affordable: the
    // guard is what stops it, not an empty account.
    await fund(db, instrument.quoteAssetId, MONEY_SCALE, FUNDING_BASE, label, CAPITAL_FUNDED_AT);

    const candidate = candidateFrom(instrument, FORMATION_QUOTE, FORMATION_NOW);
    const recordedCandidate = await recordCandidate(db, storeCandidateFrom(candidate, FORMATION_NOW));
    expect(recordedCandidate.outcome).toBe("recorded");

    // The strategy's own verdict on chasing: the ask that formed this
    // candidate is past the allowed extension, so it is MISSED — never
    // rewritten into a BUY at the higher price.
    const chase = evaluateEntry({
      candidate,
      quote: replayQuote(instrument, FORMATION_QUOTE),
      now: FORMATION_NOW,
      maxQuoteAgeMs: POLICY.maxQuoteAgeMs,
    });
    expect(chase.evaluation.outcome).toBe("MISSED");
    expect(chase.evaluation.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
    const recordedChase = await recordCandidateEvaluation(db, storeEvaluationFrom(chase.evaluation, FORMATION_NOW));
    expect(recordedChase.outcome).toBe("recorded");

    // Now the part that matters. The authorization is attempted ANYWAY,
    // through the identical translation, at the chasing price — so what
    // refuses is the application's own entry-zone gate and not this test
    // declining to make the call.
    //
    // What this case distinguishes, exactly: a translation whose approved
    // band reaches the price this dispatch would actually pay. That price is
    // 251.22 — the 250.96 ask plus the venue's 10bp cap, rounded up — against
    // an approved maximum of 250.46, a gap of 0.76. Any band widened past
    // that authorizes a spend and fails here: an unbounded or default-
    // permissive zone, a band taken from the candidate's invalidation price
    // upward, or one re-centred on the current price with a tolerance of
    // 0.76 or more.
    //
    // What it does NOT distinguish, stated so the next reader does not
    // over-claim it: a band widened only by the candidate's own
    // `allowedExtension` (0.25, reaching 250.71) still refuses, and so does a
    // zone re-derived from the quote being authorized against — see
    // `proposalFromCandidate` for why no chasing case can catch that one.
    const chaseProposal = proposalFromCandidate(
      candidate,
      instrument,
      `${label}-chase`,
      FORMATION_QUOTE.timestamps.quoteAcquiredAt,
    );
    const refusedChase = await authorizeProposal(db, {
      proposal: chaseProposal,
      quote: parsedQuoteFor(instrument, FORMATION_QUOTE),
      now: FORMATION_NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: POLICY,
      portfolio: REPLAY_PORTFOLIO,
      capital: REPLAY_CAPITAL,
    });

    expect(refusedChase.outcome).toBe("refused");
    if (refusedChase.outcome === "refused") {
      expect(refusedChase.refusal.reason).toEqual({ source: "policy", code: "OUTSIDE_ENTRY_ZONE" });
    }

    // Nothing durable: no authorization, no plan, no hold, no posting — and
    // the funded capital is untouched, to the base unit.
    expect(await loadApprovedIntent(db, chaseProposal.intentId)).toBeNull();
    expect(await loadPositionPlan(db, chaseProposal.positionPlanId)).toBeNull();
    expect(await reservationRowsFor(db, chaseProposal.intentId)).toEqual([]);
    const postings = (await loadJournalEntries(db)).filter(
      (posting) => posting.intentId === chaseProposal.intentId,
    );
    expect(postings).toEqual([]);
    const balances = await loadBalances(db);
    expect(netHoldings(balances, instrument.quoteAssetId, "available")).toBe(FUNDING_BASE);
    expect(netHoldings(balances, instrument.quoteAssetId, "reserved")).toBe(0n);

    // And the refusal above is a real gate rather than an unreachable
    // branch: the same candidate, the same translation, the same capital
    // and the same funded account DO authorize once the price is inside the
    // zone the candidate approved. Only the quote differs. This control
    // stops at the authorization deliberately — the fill, the settlement
    // and the terminal state are the case above's subject, not this one's.
    const admitted = await authorizeProposal(db, {
      proposal: proposalFromCandidate(
        candidate,
        instrument,
        `${label}-admitted`,
        ENTRY_QUOTE.timestamps.quoteAcquiredAt,
      ),
      quote: parsedQuoteFor(instrument, ENTRY_QUOTE),
      now: ENTRY_NOW,
      operatingMode: "PAPER",
      venue: VENUE,
      policyConfig: POLICY,
      portfolio: REPLAY_PORTFOLIO,
      capital: REPLAY_CAPITAL,
    });
    expect(admitted.outcome).toBe("authorized");
  });
});
