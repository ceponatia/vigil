import { assetIdSchema, decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { AssetId, DecimalString, IsoUtcTimestamp } from "@vigil/contracts";
import { createPaperExchange, PAPER_ADAPTER_CAPABILITY_VERSION } from "@vigil/adapter-paper";
import type { PaperExchange, PaperExchangeConfig } from "@vigil/adapter-paper";
import { createDbClient, postJournalEntry, recordCandidate } from "@vigil/db";
import type { StoreCandidate, StoredPositionPlan, StoreEntry, VigilDatabase } from "@vigil/db";
import { quoteSnapshotSchema } from "@vigil/market";
import type { QuoteSnapshot } from "@vigil/market";
import { parsePolicyConfig } from "@vigil/policy";
import type { ExposureCap, PolicyConfig, ReconciliationState } from "@vigil/policy";

import type { CapitalState, TradeProposal } from "../authorize";
import type { DispatchIdentities, ExecutionRuntime } from "../dispatch";
import type { Instrument, PositionPlanTerms } from "../position-plan";
import type { PortfolioState } from "../revalidate";
import type { SettlementIdentities } from "../settle";
import { parseVenueExecutionConfig } from "../venue";
import type { VenueExecutionConfig } from "../venue";

/**
 * execution-fixtures.ts — the synthetic venue, market and portfolio the
 * execution suites drive. Never imported by anything but a `*.test.ts` in
 * this directory.
 *
 * Everything here is synthetic and deterministic: chain `1337` — the id this
 * codebase reserves for the synthetic test chain — denominations no real
 * chain issues, a paper exchange with a fixed seed, and injected timestamps.
 * No address, key, holding, venue credential, or real instrument appears.
 *
 * **Every suite names its own asset pair.** The integration cases share one
 * database and cannot truncate it — `journal_entries` and `approved_intents`
 * are append-only by trigger, and `TRUNCATE` lives in `packages/db`'s own
 * test support, which is package-internal and correctly unreachable from
 * here. Per-case assets give every case its own account keys, its own
 * `asset_scales` rows, and its own balances, so no case can assert against
 * another's leftovers. That is stricter than a shared reset, not looser: two
 * cases cannot interfere even if one of them leaves state behind.
 *
 * ## The numbers, and why they are these numbers
 *
 * Money scale 2, quantity scale 4, a 25bp fee, a 10bp slippage cap and a
 * flat `0.50` cost. Against a `250.00 / 250.10` book that gives, for a buy:
 *
 * | figure | value |
 * | --- | --- |
 * | reference mid (rounded down for a buy) | `250.05` |
 * | reference price (the ask) | `250.10` |
 * | execution price (ask + 10bp, rounded up) | `250.36` |
 * | spread per unit (`ask - mid`) | `0.05` |
 * | slippage per unit (`execution - ask`) | `0.26` |
 *
 * The flat cost is the load-bearing one: it does not scale with size, so the
 * same per-unit edge clears the hurdle comfortably at a whole unit and
 * cannot clear it at a fraction of one. That contrast is the small-notional
 * scenario, and it is a property of these numbers rather than something a
 * test has to arrange.
 */

const CHAIN = "1337";
const NETWORK = "SYNTHETIC_TESTNET";

/** A distinct synthetic asset pair. `label` must differ per suite case. */
export function syntheticInstrument(label: string): Instrument {
  return {
    baseAssetId: assetIdSchema.parse(`${CHAIN}|native|VGLB${label.toUpperCase()}|${NETWORK}`),
    quoteAssetId: assetIdSchema.parse(`${CHAIN}|native|VGLQ${label.toUpperCase()}|${NETWORK}`),
  };
}

export const MONEY_SCALE = 2;
export const QUANTITY_SCALE = 4;

export function instant(value: string): IsoUtcTimestamp {
  return isoUtcTimestampSchema.parse(value);
}

/**
 * A decimal amount, parsed rather than asserted. `DecimalString` is branded
 * precisely so an arbitrary string cannot reach a money field, and a fixture
 * that cast past that brand would be building records the application cannot
 * produce.
 */
export function money(value: string): DecimalString {
  return decimalStringSchema.parse(value);
}

export const QUOTE_ACQUIRED_AT = "2026-03-01T12:00:00.000Z";
export const NOW = instant("2026-03-01T12:00:01.000Z");

/**
 * A raw, unparsed quote snapshot — the shape the execution path receives at
 * its trust boundary. Prices default to the book the table above describes.
 */
export function rawQuote(
  instrument: Instrument,
  overrides: {
    readonly bidPrice?: string;
    readonly askPrice?: string;
    readonly askQuantity?: string;
    readonly quoteAcquiredAt?: string;
  } = {},
): unknown {
  const askQuantity = overrides.askQuantity ?? "1.0000";
  const acquiredAt = overrides.quoteAcquiredAt ?? QUOTE_ACQUIRED_AT;
  return {
    instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
    bidPrice: overrides.bidPrice ?? "250.00",
    askPrice: overrides.askPrice ?? "250.10",
    bidQuantity: askQuantity,
    askQuantity,
    timestamps: { quoteAcquiredAt: acquiredAt, ingestedAt: acquiredAt },
  };
}

/**
 * The same quote, parsed through `@vigil/market`'s own schema — what
 * `authorizeProposal` takes. A fixture that could not itself pass the
 * market boundary would be testing the execution path against quotes the
 * application can never receive.
 */
export function parsedQuote(instrument: Instrument, overrides: Parameters<typeof rawQuote>[1] = {}): QuoteSnapshot {
  return quoteSnapshotSchema.parse(rawQuote(instrument, overrides));
}

export function venueConfig(overrides: Partial<Record<string, unknown>> = {}): VenueExecutionConfig {
  const parsed = parseVenueExecutionConfig({
    venueId: "paper-synthetic",
    adapterCapabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
    moneyScale: MONEY_SCALE,
    quantityScale: QUANTITY_SCALE,
    feeBasisPoints: 25,
    slippageBasisPoints: 10,
    fixedExecutionCostQuote: "0.50",
    costModelVersion: "cost-model-test-0",
    feeSnapshotVersion: "fee-snapshot-test-0",
    ...overrides,
  });
  if (parsed.outcome === "refused") {
    throw new Error(`fixture venue config did not parse: ${parsed.refusal.detail}`);
  }
  return parsed.venue;
}

/**
 * The limit set. Deliberately permissive on size and strict on edge: these
 * suites are about the economic gate, so the minimum quantity and notional
 * are low enough that a tiny trade reaches the net-edge check instead of
 * being skipped for size before it gets there.
 */
export function policyConfig(overrides: Partial<Record<string, unknown>> = {}): PolicyConfig {
  const parsed = parsePolicyConfig({
    maxQuoteAgeMs: 60_000,
    maxReconciliationAgeMs: 600_000,
    minimumNetEdgeQuote: "1.00",
    quantityScale: QUANTITY_SCALE,
    minimumQuantity: "0.0001",
    minimumNotionalQuote: "1.00",
    ...overrides,
  });
  if (parsed.outcome === "refused") {
    throw new Error(`fixture policy config did not parse: ${parsed.refusal.detail}`);
  }
  return parsed.config;
}

export const RECONCILED: ReconciliationState = {
  reconciledThrough: instant("2026-03-01T11:59:00.000Z"),
  unresolvedDiscrepancyCount: 0,
};

export function exposureCap(overrides: Partial<ExposureCap> = {}): ExposureCap {
  return {
    scope: "asset",
    label: "synthetic-asset-cap",
    currentExposureQuote: money("0"),
    capQuote: money("10000.00"),
    ...overrides,
  };
}

export function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return { account: RECONCILED, exposureCaps: [exposureCap()], ...overrides };
}

export function capital(overrides: Partial<CapitalState> = {}): CapitalState {
  return {
    fundsAvailableQuote: money("10000.00"),
    adverseLossBudgetQuote: money("1000.00"),
    stopDistanceQuote: money("10.00"),
    ...overrides,
  };
}

/**
 * The plan terms a proposal is approved under.
 *
 * Supplied to `authorizeProposal` and to nothing else: the approval writes
 * them to `position_plans`, and every dispatch reads them back from there.
 * No fixture hands them to `dispatchAttempt`, because `DispatchRequest` has
 * no field for them — which is the property #54 exists to establish.
 */
export function planTerms(overrides: Partial<PositionPlanTerms> = {}): PositionPlanTerms {
  return {
    entryZone: { min: money("200.00"), max: money("300.00") },
    thesis: { expectedExitPriceQuote: money("260.00") },
    ...overrides,
  };
}

/**
 * A stored plan row, as `loadPositionPlan` hands one back.
 *
 * Only the pure `planTermsFor` cases build one directly. Every integration
 * case gets its plan the way the application does — written by
 * `authorizeProposal` — so no suite can pass against a plan shape the
 * approval path does not actually produce.
 */
export function storedPlan(
  label: string,
  instrument: Instrument,
  overrides: Partial<StoredPositionPlan> = {},
): StoredPositionPlan {
  const plan = planTerms();
  return {
    positionPlanId: `plan-${label}`,
    correlationId: `corr-${label}`,
    instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
    entryZoneMin: plan.entryZone.min,
    entryZoneMax: plan.entryZone.max,
    thesisExitPrice: plan.thesis.expectedExitPriceQuote,
    formationReferenceMid: "250.05",
    formedAt: QUOTE_ACQUIRED_AT,
    recordedAt: QUOTE_ACQUIRED_AT,
    provenance: {
      policyVersion: "policy-test-0",
      strategyVersion: "strategy-test-0",
      modelVersion: null,
      portfolioSnapshotVersion: "portfolio-snapshot-test-0",
      marketSnapshotVersion: "market-snapshot-test-0",
    },
    ...overrides,
  };
}

export function proposal(label: string, instrument: Instrument, overrides: Partial<TradeProposal> = {}): TradeProposal {
  const plan = planTerms();
  return {
    intentId: `intent-${label}`,
    idempotencyKey: `idem-${label}`,
    correlationId: `corr-${label}`,
    economicActionId: `action-${label}`,
    positionPlanId: `plan-${label}`,
    candidateId: null,
    fundingAccountId: "account-synthetic",
    action: "BUY",
    baseAssetId: instrument.baseAssetId,
    quoteAssetId: instrument.quoteAssetId,
    entryZone: plan.entryZone,
    thesis: plan.thesis,
    minAcceptableReceiptQuantity: money("0.0001"),
    permittedResidualQuote: money("1.00"),
    validUntil: instant("2026-03-01T13:00:00.000Z"),
    requiredFreshnessMs: 60_000,
    protectionPlan: null,
    remainingInventoryTreatment: "leave-as-is",
    benchmarkId: null,
    approvalReason: "synthetic fixture",
    quoteId: `quote-${label}`,
    provenance: {
      policyVersion: "policy-test-0",
      strategyVersion: "strategy-test-0",
      modelVersion: null,
      portfolioSnapshotVersion: "portfolio-snapshot-test-0",
      marketSnapshotVersion: "market-snapshot-test-0",
    },
    ...overrides,
  };
}

export function dispatchIds(label: string, overrides: Partial<DispatchIdentities> = {}): DispatchIdentities {
  return {
    attemptId: `attempt-${label}`,
    dispatchId: `dispatch-${label}`,
    reservationId: `reservation-${label}`,
    reservationEntryId: `hold-${label}`,
    blockedEvaluationId: `evaluation-${label}`,
    ...overrides,
  };
}

/**
 * A journaled candidate for an intent to point at.
 *
 * Only the cases about a refused gate need one: `approved_intents.candidate_id`
 * is nullable because a protective action has none, so the ordinary fixtures
 * leave it null and only a case asserting the skip is journaled wires this
 * up. Every price is the book `rawQuote` describes, so the candidate and the
 * quotes driven against it are the same market.
 */
export function syntheticCandidate(label: string, instrument: Instrument): StoreCandidate {
  return {
    candidateId: `candidate-${label}`,
    idempotencyKey: `idem-candidate-${label}`,
    correlationId: `corr-${label}`,
    strategyId: "strategy-test-0",
    instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
    action: "BUY",
    actionDetail: "SMALL_STARTER",
    horizon: "swing",
    entryZoneMin: "200.00",
    entryZoneMax: "300.00",
    allowedExtension: "0.50",
    invalidationPrice: "180.00",
    invalidationConditions: ["closes below the prior swing low"],
    expiresAt: "2026-03-01T13:00:00.000Z",
    benchmarkId: "benchmark-hold-settlement-reserve",
    marketSnapshot: {
      quoteAcquiredAt: QUOTE_ACQUIRED_AT,
      ingestedAt: QUOTE_ACQUIRED_AT,
      bidPrice: "250.00",
      askPrice: "250.10",
    },
    generatedAt: "2026-03-01T11:59:00.000Z",
    recordedAt: "2026-03-01T11:59:00.500Z",
    provenance: {
      policyVersion: "policy-test-0",
      strategyVersion: "strategy-test-0",
      modelVersion: null,
      portfolioSnapshotVersion: null,
      marketSnapshotVersion: null,
    },
    tranches: [{ index: 0, quantity: "1.0000", triggerPrice: null }],
  };
}

/** Writes that candidate and hands back its id, so an intent can name it. */
export async function recordCandidateFor(db: VigilDatabase, label: string, instrument: Instrument): Promise<string> {
  const candidate = syntheticCandidate(label, instrument);
  const written = await recordCandidate(db, candidate);
  if (written.outcome === "refused") {
    throw new Error(`fixture candidate did not record (${written.code}): ${written.detail}`);
  }
  return written.candidateId;
}

export function settlementIds(label: string): SettlementIdentities {
  return {
    tradeEntryId: `trade-${label}`,
    feeEntryId: `fee-${label}`,
    releaseEntryId: `release-${label}`,
  };
}

export function paperExchange(overrides: Partial<PaperExchangeConfig> = {}): PaperExchange {
  return createPaperExchange({
    seed: 20_260_301,
    moneyScale: MONEY_SCALE,
    quantityScale: QUANTITY_SCALE,
    feeBasisPoints: 25,
    slippageBasisPoints: 10,
    fixedExecutionCost: money("0.50"),
    ...overrides,
  });
}

export function runtime(db: VigilDatabase, exchange: PaperExchange, overrides: Partial<ExecutionRuntime> = {}): ExecutionRuntime {
  return {
    db,
    exchange,
    venue: venueConfig(),
    policyConfig: policyConfig(),
    dispatcherInstanceId: "trading-test-0",
    fencingToken: 1n,
    ...overrides,
  };
}

/** A pool against the integration database named by `DATABASE_URL`. */
export function openExecutionTestDb(applicationName: string): {
  readonly db: VigilDatabase;
  readonly close: () => Promise<void>;
} {
  const client = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", applicationName });
  return { db: client.db, close: client.close };
}

/**
 * When a funding contribution happened, for a suite that does not say.
 *
 * Twelve hours before `NOW`, on the same day every other instant in these
 * fixtures sits on: capital has to be in the account before the trade that
 * spends it, and a suite reading its own journal should not find the deposit
 * dated after the trade.
 */
export const FUNDED_AT = "2026-03-01T00:00:00.000Z";

/**
 * Funds an asset's `available` balance with a synthetic owner deposit —
 * basis in, never profit — so a reservation has something to hold.
 *
 * `occurredAt` defaults to `FUNDED_AT`, which is what every suite anchored to
 * this file's own 2026-03-01 clock wants. A suite driving a recording from
 * another era passes its own instant instead, so the contribution is not
 * dated years after the trade it pays for — the timestamp family is evidence,
 * and an impossible ordering in it is a defect whether or not an assertion
 * reads it.
 */
export async function fund(
  db: VigilDatabase,
  assetId: AssetId,
  scale: number,
  amountBase: bigint,
  label: string,
  occurredAt: string = FUNDED_AT,
): Promise<void> {
  const entry: StoreEntry = {
    entryId: `funding-${label}`,
    kind: "contribution",
    occurredAt,
    recordedAt: occurredAt,
    correlationId: `corr-funding-${label}`,
    idempotencyKey: `idem-funding-${label}`,
    intentId: null,
    reversesEntryId: null,
    provenance: {
      policyVersion: "policy-test-0",
      strategyVersion: "strategy-test-0",
      modelVersion: null,
      portfolioSnapshotVersion: null,
      marketSnapshotVersion: null,
    },
    lines: [
      { account: { family: "holdings", assetId, holdingsState: "available" }, scale, amountBase, direction: "debit" },
      { account: { family: "contributed-capital", assetId, holdingsState: null }, scale, amountBase, direction: "credit" },
    ],
  };

  const posted = await postJournalEntry(db, entry);
  if (posted.outcome === "refused") {
    throw new Error(`fixture funding did not post (${posted.code}): ${posted.detail}`);
  }
}
