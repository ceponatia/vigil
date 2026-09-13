import { createHash } from "node:crypto";
import { z } from "zod";
import { ageMs, decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp, ReasonCode } from "@vigil/contracts";
import { evaluateQuoteFreshness, instrumentIdSchema } from "@vigil/market";
import type { InstrumentId } from "@vigil/market";

import { buildPositionPlan, positionPlanSchema } from "./position-plan";
import { addDecimal, compareDecimal, subtractDecimal } from "./scaled-decimal";

/**
 * candidate.ts — the frozen, schema-validated candidate record (TASK-08:
 * "Log eligible candidates before their outcomes") and the deterministic
 * numeric generator that produces one from a quote. No LLM, no IO, no
 * clock read (`now` is always injected) — this package's README, "What it
 * must never do".
 *
 * `packages/db`'s concurrent `candidates` table (this issue's persistence
 * half) is where a `Candidate` actually becomes durable; this module's
 * job ends at handing back a complete, immutable, schema-valid record
 * before any outcome is known. `generateCandidate` and `evaluateEntry`
 * (`no-chasing.ts`) never persist anything themselves.
 */

const ZERO: DecimalString = decimalStringSchema.parse("0");

function isNonNegativeDecimal(value: DecimalString): boolean {
  // decimalStringSchema already rejects the "-0" spelling, so the only
  // way a validated DecimalString reads as negative is a leading "-".
  return !value.startsWith("-");
}

/**
 * Every field on `Candidate` and `EntryEvaluation` is derived from the
 * same four values so the same event delivered twice always yields the
 * same ids (idempotent persistence downstream). `tag` namespaces the
 * digest so `candidateId`, `idempotencyKey`, and `correlationId` — all
 * derived from identical inputs — don't collide. Hashing is pure CPU
 * work, not IO: no filesystem, no network, no randomness.
 */
export function deriveDeterministicId(tag: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update([tag, ...parts].join("|")).digest("hex");
  return `${tag}_${digest.slice(0, 32)}`;
}

export const HORIZONS = ["intraday", "swing", "position"] as const;
export type Horizon = (typeof HORIZONS)[number];

const marketSnapshotSchema = z.object({
  quoteAcquiredAt: isoUtcTimestampSchema,
  ingestedAt: isoUtcTimestampSchema,
  bidPrice: decimalStringSchema,
  askPrice: decimalStringSchema,
});

/**
 * The candidate record (`docs/architecture.md` "Contracts" — the
 * `TradeProposal` shape this mirrors: `entryZone`, `expiresAt`,
 * `invalidationConditions`, `horizon`, `actionDetail`). Cross-field
 * invariants a plain shape check cannot express — the zone ordering, the
 * invalidation price sitting strictly below it, the expiry sitting after
 * generation, and the position plan's tranches actually summing to its
 * total and triggering only inside the zone — are enforced in
 * `superRefine` below, so a hand-built literal that violates any of them
 * fails to parse rather than becoming a `Candidate` that looks valid.
 */
export const candidateSchema = z
  .object({
    candidateId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    correlationId: z.string().min(1),
    strategyId: z.string().min(1),
    strategyVersion: z.string().min(1),
    instrumentId: instrumentIdSchema,
    action: z.literal("BUY"),
    actionDetail: z.string().min(1),
    horizon: z.enum(HORIZONS),
    entryZone: z.object({ min: decimalStringSchema, max: decimalStringSchema }),
    allowedExtension: decimalStringSchema,
    invalidationPrice: decimalStringSchema,
    invalidationConditions: z.array(z.string().min(1)).min(1),
    expiresAt: isoUtcTimestampSchema,
    benchmarkId: z.string().min(1),
    marketSnapshot: marketSnapshotSchema,
    generatedAt: isoUtcTimestampSchema,
    positionPlan: positionPlanSchema,
  })
  .superRefine((candidate, ctx) => {
    if (compareDecimal(candidate.entryZone.min, candidate.entryZone.max) > 0) {
      ctx.addIssue({ code: "custom", path: ["entryZone"], message: "entryZone.min must be <= entryZone.max" });
    }
    if (!isNonNegativeDecimal(candidate.allowedExtension)) {
      ctx.addIssue({ code: "custom", path: ["allowedExtension"], message: "allowedExtension must be >= 0" });
    }
    if (compareDecimal(candidate.invalidationPrice, candidate.entryZone.min) >= 0) {
      ctx.addIssue({ code: "custom", path: ["invalidationPrice"], message: "invalidationPrice must be strictly less than entryZone.min" });
    }
    if (ageMs(candidate.generatedAt, candidate.expiresAt) <= 0) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be strictly after generatedAt" });
    }

    const sortedIndexes = candidate.positionPlan.tranches.map((tranche) => tranche.index).sort((a, b) => a - b);
    const indexesAreContiguous = sortedIndexes.every((index, position) => index === position);
    if (!indexesAreContiguous) {
      ctx.addIssue({ code: "custom", path: ["positionPlan", "tranches"], message: "tranche indexes must be exactly 0..tranches.length-1, each once" });
    }

    const quantitySum = candidate.positionPlan.tranches.reduce((sum, tranche) => addDecimal(sum, tranche.quantity), ZERO);
    if (compareDecimal(quantitySum, candidate.positionPlan.totalQuantity) !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["positionPlan", "tranches"],
        message: `tranche quantities sum to ${quantitySum}, not positionPlan.totalQuantity (${candidate.positionPlan.totalQuantity})`,
      });
    }

    candidate.positionPlan.tranches.forEach((tranche, position) => {
      const insideZone =
        compareDecimal(tranche.triggerPrice, candidate.entryZone.min) >= 0 &&
        compareDecimal(tranche.triggerPrice, candidate.entryZone.max) <= 0;
      if (!insideZone) {
        ctx.addIssue({
          code: "custom",
          path: ["positionPlan", "tranches", position, "triggerPrice"],
          message: `triggerPrice ${tranche.triggerPrice} is outside entryZone [${candidate.entryZone.min}, ${candidate.entryZone.max}]`,
        });
      }
    });
  })
  .brand<"Candidate">();

export type Candidate = z.infer<typeof candidateSchema>;

/** Deep-freezes exactly the nested shapes `candidateSchema` produces. */
function freezeCandidate(candidate: Candidate): Candidate {
  candidate.positionPlan.tranches.forEach((tranche) => Object.freeze(tranche));
  Object.freeze(candidate.positionPlan.tranches);
  Object.freeze(candidate.positionPlan);
  Object.freeze(candidate.entryZone);
  Object.freeze(candidate.marketSnapshot);
  Object.freeze(candidate.invalidationConditions);
  return Object.freeze(candidate);
}

/**
 * Every `DecimalString`/integer input the numeric rule needs, with a
 * documented default. Alpha (which asset, how much conviction) is out of
 * scope for this issue — the lifecycle and the no-chasing guarantee are
 * the point, not the rule's edge.
 */
export type StrategyConfig = {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly actionDetail: string;
  readonly horizon: Horizon;
  /** Distance below the current ask where the entry zone's top (`max`) sits. */
  readonly pullback: DecimalString;
  /** Width of the entry zone: `min = max - zoneWidth`. Must be > 0. */
  readonly zoneWidth: DecimalString;
  /** Distance below `min` where the thesis is invalidated. Must be > 0. */
  readonly invalidationOffset: DecimalString;
  /** How far above `max` still counts as WAIT rather than MISSED. */
  readonly allowedExtension: DecimalString;
  /** Number of staged tranches (>= 1) splitting `totalQuantity`. */
  readonly trancheCount: number;
  /** The bounded total size across every tranche (sizing policy is BOOT-06's job; this is a fixed starter size). */
  readonly totalQuantity: DecimalString;
  /** Milliseconds from `generatedAt` to `expiresAt`. */
  readonly expiryMs: number;
};

/**
 * A conservative bounded pullback-buy: wait for the ask to pull back
 * `"2.00"` off its current level, treat a further `"3.00"` band below
 * that as the approved zone, invalidate the thesis `"2.00"` below the
 * zone's floor, tolerate up to `"1.00"` of overshoot above the zone as
 * still-waitable, split a `"3.0000"`-unit starter position across three
 * tranches, and let the whole candidate expire after 24 hours.
 */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  strategyId: "bounded-pullback-v1",
  strategyVersion: "1.0.0",
  actionDetail: "SMALL_STARTER",
  horizon: "swing",
  pullback: decimalStringSchema.parse("2.00"),
  zoneWidth: decimalStringSchema.parse("3.00"),
  invalidationOffset: decimalStringSchema.parse("2.00"),
  allowedExtension: decimalStringSchema.parse("1.00"),
  trancheCount: 3,
  totalQuantity: decimalStringSchema.parse("3.0000"),
  expiryMs: 24 * 60 * 60 * 1000,
};

/**
 * `config` is a deploy-time value, never untrusted external input, so an
 * invalid one is a programmer error and throws (docs/resilience.md §4
 * reserves exceptions for exactly this case) rather than returning a
 * `no-candidate` diagnostic — the same posture `generateSyntheticQuotes`
 * takes for its own params.
 */
function assertValidStrategyConfig(config: StrategyConfig): void {
  for (const field of ["strategyId", "strategyVersion", "actionDetail"] as const) {
    if (config[field].length === 0) {
      throw new Error(`generateCandidate: config.${field} must be a non-empty string`);
    }
  }
  if (!isNonNegativeDecimal(config.pullback)) {
    throw new Error(`generateCandidate: config.pullback must be >= 0, got ${config.pullback}`);
  }
  if (compareDecimal(config.zoneWidth, ZERO) <= 0) {
    throw new Error(`generateCandidate: config.zoneWidth must be > 0, got ${config.zoneWidth}`);
  }
  if (compareDecimal(config.invalidationOffset, ZERO) <= 0) {
    throw new Error(`generateCandidate: config.invalidationOffset must be > 0, got ${config.invalidationOffset}`);
  }
  if (!isNonNegativeDecimal(config.allowedExtension)) {
    throw new Error(`generateCandidate: config.allowedExtension must be >= 0, got ${config.allowedExtension}`);
  }
  if (compareDecimal(config.totalQuantity, ZERO) <= 0) {
    throw new Error(`generateCandidate: config.totalQuantity must be > 0, got ${config.totalQuantity}`);
  }
  if (!Number.isInteger(config.trancheCount) || config.trancheCount < 1) {
    throw new Error(`generateCandidate: config.trancheCount must be a positive integer, got ${String(config.trancheCount)}`);
  }
  if (!Number.isInteger(config.expiryMs) || config.expiryMs <= 0) {
    throw new Error(`generateCandidate: config.expiryMs must be a positive integer, got ${String(config.expiryMs)}`);
  }
}

/** Pure: `Date.parse`/`new Date(ms)` read no clock when both arguments are already-known values (the same reasoning `@vigil/market`'s synthetic-feed.ts documents for its own timestamp arithmetic). */
function addMillis(timestamp: IsoUtcTimestamp, millis: number): IsoUtcTimestamp {
  return isoUtcTimestampSchema.parse(new Date(Date.parse(timestamp) + millis).toISOString());
}

/** The two canonical asset-id halves an `InstrumentId` always splits into (`@vigil/market`'s `instrumentIdSchema`). */
function quoteAssetIdOf(instrumentId: InstrumentId): string {
  const separatorIndex = instrumentId.indexOf("/");
  return instrumentId.slice(separatorIndex + 1);
}

export type GenerateCandidateParams = {
  /** Untrusted input — parsed via `evaluateQuoteFreshness` before use. */
  readonly quote: unknown;
  readonly now: IsoUtcTimestamp;
  readonly maxQuoteAgeMs: number;
  readonly config: StrategyConfig;
};

export type GenerateCandidateResult =
  | { readonly outcome: "candidate"; readonly candidate: Candidate }
  | { readonly outcome: "no-candidate"; readonly reasonCode: ReasonCode; readonly detail: string };

/**
 * Generates one `BUY` candidate with a staged position plan from a quote,
 * or refuses with a reason code. Never throws on schema-legal `quote`
 * input — a stale or corrupt quote fails closed through
 * `evaluateQuoteFreshness`'s own `STALE_QUOTE` (docs/testing.md
 * "Quote/book is stale or corrupt") — and `config` is validated as a
 * programmer-error guard, not a diagnostic path.
 */
export function generateCandidate(params: GenerateCandidateParams): GenerateCandidateResult {
  assertValidStrategyConfig(params.config);

  const freshness = evaluateQuoteFreshness({ raw: params.quote, now: params.now, maxAgeMs: params.maxQuoteAgeMs });
  if (!freshness.executable) {
    return { outcome: "no-candidate", reasonCode: freshness.reasonCode, detail: freshness.detail };
  }

  const quote = freshness.quote;
  const config = params.config;

  const max = subtractDecimal(quote.askPrice, config.pullback);
  const min = subtractDecimal(max, config.zoneWidth);
  const invalidationPrice = subtractDecimal(min, config.invalidationOffset);

  // The ask price is schema-legal market data; a non-positive computed
  // zone means this StrategyConfig is misconfigured for the current
  // price level (e.g. pullback + zoneWidth + invalidationOffset exceeds
  // the ask), not a defect in the quote — a config/programmer-error guard,
  // same posture as assertValidStrategyConfig above.
  if (compareDecimal(invalidationPrice, ZERO) <= 0) {
    throw new Error(
      `generateCandidate: config produces a non-positive invalidationPrice (${invalidationPrice}) against ask ${quote.askPrice}; pullback/zoneWidth/invalidationOffset are too large for this price level`,
    );
  }

  const positionPlan = buildPositionPlan({ totalQuantity: config.totalQuantity, trancheCount: config.trancheCount, entryZone: { min, max } });
  const expiresAt = addMillis(params.now, config.expiryMs);
  const benchmarkId = `hold:${quoteAssetIdOf(quote.instrumentId)}`;

  const idParts = [config.strategyId, config.strategyVersion, quote.instrumentId, quote.timestamps.quoteAcquiredAt];
  const candidateId = deriveDeterministicId("candidate", idParts);
  const idempotencyKey = deriveDeterministicId("candidate-idempotency", idParts);
  const correlationId = deriveDeterministicId("candidate-correlation", idParts);

  const invalidationConditions = [
    `ask price falls below ${invalidationPrice} for ${quote.instrumentId} (thesis invalidated)`,
    `no fill by this candidate's expiry at ${expiresAt} (research expired)`,
  ];

  const candidate = candidateSchema.parse({
    candidateId,
    idempotencyKey,
    correlationId,
    strategyId: config.strategyId,
    strategyVersion: config.strategyVersion,
    instrumentId: quote.instrumentId,
    action: "BUY",
    actionDetail: config.actionDetail,
    horizon: config.horizon,
    entryZone: { min, max },
    allowedExtension: config.allowedExtension,
    invalidationPrice,
    invalidationConditions,
    expiresAt,
    benchmarkId,
    marketSnapshot: {
      quoteAcquiredAt: quote.timestamps.quoteAcquiredAt,
      ingestedAt: quote.timestamps.ingestedAt,
      bidPrice: quote.bidPrice,
      askPrice: quote.askPrice,
    },
    generatedAt: params.now,
    positionPlan,
  });

  return { outcome: "candidate", candidate: freezeCandidate(candidate) };
}
