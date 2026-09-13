import { describe, expect, it } from "vitest";
import { decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";

import { DEFAULT_STRATEGY_CONFIG, candidateSchema, generateCandidate } from "./candidate";
import type { StrategyConfig } from "./candidate";
import { addDecimal, compareDecimal } from "./scaled-decimal";
import { validRawQuote } from "./test-support/quote-fixtures";

const ZERO_QUANTITY = decimalStringSchema.parse("0");

const now = (value: string): IsoUtcTimestamp => isoUtcTimestampSchema.parse(value);
const MAX_QUOTE_AGE_MS = 5_000;
const FRESH_NOW = now("2024-01-01T00:00:01.000Z"); // 1s after validRawQuote's quoteAcquiredAt

function freshCandidate(config: StrategyConfig = DEFAULT_STRATEGY_CONFIG) {
  const result = generateCandidate({ quote: validRawQuote, now: FRESH_NOW, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config });
  if (result.outcome !== "candidate") {
    throw new Error(`expected a candidate, got no-candidate: ${result.reasonCode} ${result.detail}`);
  }
  return result.candidate;
}

// Acceptance item 1: "A candidate carries entry zone, expiry, invalidation
// condition, horizon, a bounded tranche, and a benchmark reference (unit
// test asserts all fields are populated)." Kills a generator that forgets
// to populate a required field (it would fail candidateSchema.parse and
// throw inside generateCandidate) or that computes a plan whose tranches
// don't actually reconcile with what it claims to total.
describe("generateCandidate — every required field is populated and internally consistent", () => {
  it("produces a schema-valid candidate with every documented field present", () => {
    const candidate = freshCandidate();
    // Re-parsing proves nothing new about the schema itself (that's zod's
    // job), but does prove generateCandidate's own output is exactly what
    // candidateSchema accepts — no field silently bypassing validation.
    expect(candidateSchema.safeParse(candidate).success).toBe(true);

    expect(candidate.candidateId.length).toBeGreaterThan(0);
    expect(candidate.idempotencyKey.length).toBeGreaterThan(0);
    expect(candidate.correlationId.length).toBeGreaterThan(0);
    expect(candidate.action).toBe("BUY");
    expect(candidate.actionDetail.length).toBeGreaterThan(0);
    expect(candidate.horizon).toBe(DEFAULT_STRATEGY_CONFIG.horizon);
    expect(candidate.invalidationConditions.length).toBeGreaterThan(0);
    expect(candidate.benchmarkId.length).toBeGreaterThan(0);
    expect(candidate.positionPlan.tranches.length).toBeGreaterThan(0);
  });

  it("computes the bounded pullback zone from the ask price using the exact configured offsets", () => {
    const candidate = freshCandidate();
    // ask 250.10 - pullback 2.00 = max 248.10; max - zoneWidth 3.00 = min 245.10;
    // min - invalidationOffset 2.00 = invalidationPrice 243.10.
    expect(compareDecimal(candidate.entryZone.max, decimalStringSchema.parse("248.10"))).toBe(0);
    expect(compareDecimal(candidate.entryZone.min, decimalStringSchema.parse("245.10"))).toBe(0);
    expect(compareDecimal(candidate.invalidationPrice, decimalStringSchema.parse("243.10"))).toBe(0);
    expect(compareDecimal(candidate.allowedExtension, DEFAULT_STRATEGY_CONFIG.allowedExtension)).toBe(0);
  });

  it("the position plan's tranche quantities sum exactly to totalQuantity, and every trigger price is inside the entry zone", () => {
    const candidate = freshCandidate();
    const quantitySum: DecimalString = candidate.positionPlan.tranches.reduce(
      (sum, tranche) => addDecimal(sum, tranche.quantity),
      ZERO_QUANTITY,
    );
    expect(compareDecimal(quantitySum, candidate.positionPlan.totalQuantity)).toBe(0);

    for (const tranche of candidate.positionPlan.tranches) {
      expect(compareDecimal(tranche.triggerPrice, candidate.entryZone.min)).toBeGreaterThanOrEqual(0);
      expect(compareDecimal(tranche.triggerPrice, candidate.entryZone.max)).toBeLessThanOrEqual(0);
    }
  });

  it("expiresAt is generatedAt plus config.expiryMs, and generatedAt is exactly the injected now — this module reads no clock", () => {
    const candidate = freshCandidate();
    expect(candidate.generatedAt).toBe(FRESH_NOW);
    expect(Date.parse(candidate.expiresAt) - Date.parse(candidate.generatedAt)).toBe(DEFAULT_STRATEGY_CONFIG.expiryMs);
  });

  it("benchmarkId names the quote asset, never the base asset — the passive held-asset benchmark is what the candidate is priced against", () => {
    const candidate = freshCandidate();
    expect(candidate.benchmarkId.startsWith("hold:")).toBe(true);
    expect(candidate.benchmarkId).toContain("VGLQUOTE");
    expect(candidate.benchmarkId).not.toContain("VGLBASE");
  });

  it("marketSnapshot carries the quote's own prices and timestamps, unmodified", () => {
    const candidate = freshCandidate();
    expect(candidate.marketSnapshot.askPrice).toBe(validRawQuote.askPrice);
    expect(candidate.marketSnapshot.bidPrice).toBe(validRawQuote.bidPrice);
    expect(candidate.marketSnapshot.quoteAcquiredAt).toBe(validRawQuote.timestamps.quoteAcquiredAt);
    expect(candidate.marketSnapshot.ingestedAt).toBe(validRawQuote.timestamps.ingestedAt);
  });

  it("the candidate object is frozen — a caller cannot mutate the zone, the plan, or the tranches after the fact", () => {
    const candidate = freshCandidate();
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.entryZone)).toBe(true);
    expect(Object.isFrozen(candidate.positionPlan)).toBe(true);
    expect(Object.isFrozen(candidate.positionPlan.tranches)).toBe(true);
    expect(Object.isFrozen(candidate.positionPlan.tranches[0])).toBe(true);
  });
});

// Acceptance item 5 (determinism): "same inputs → deep-equal candidate and
// identical ids". Kills a generator that (accidentally) reaches for
// Math.random(), Date.now(), or object identity instead of the documented
// four-field derivation — any of which would make the same event delivered
// twice mint two different candidates instead of persisting as one.
describe("generateCandidate — determinism", () => {
  it("two calls with identical params produce a deeply equal candidate", () => {
    const first = freshCandidate();
    const second = freshCandidate();
    expect(second).toEqual(first);
    expect(second.candidateId).toBe(first.candidateId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.correlationId).toBe(first.correlationId);
  });

  it("a structurally-equal but distinct quote object (same quoteAcquiredAt) yields identical ids — determinism is keyed on values, not object identity", () => {
    const first = freshCandidate();
    const second = generateCandidate({
      quote: { ...validRawQuote, timestamps: { ...validRawQuote.timestamps } },
      now: FRESH_NOW,
      maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(second.outcome).toBe("candidate");
    if (second.outcome === "candidate") {
      expect(second.candidate.candidateId).toBe(first.candidateId);
    }
  });

  it("a different quoteAcquiredAt (a genuinely different event) yields a different candidateId", () => {
    const first = freshCandidate();
    const laterQuote = {
      ...validRawQuote,
      timestamps: { quoteAcquiredAt: "2024-01-01T00:01:00.000Z", ingestedAt: "2024-01-01T00:01:00.250Z" },
    };
    const second = generateCandidate({ quote: laterQuote, now: now("2024-01-01T00:01:01.000Z"), maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config: DEFAULT_STRATEGY_CONFIG });
    expect(second.outcome).toBe("candidate");
    if (second.outcome === "candidate") {
      expect(second.candidate.candidateId).not.toBe(first.candidateId);
    }
  });
});

describe("generateCandidate — a stale or corrupt quote never becomes a candidate", () => {
  it("returns no-candidate with STALE_QUOTE for a quote older than maxQuoteAgeMs, never throwing", () => {
    const farFuture = now("2024-01-01T01:00:00.000Z"); // one hour after quoteAcquiredAt
    expect(() => generateCandidate({ quote: validRawQuote, now: farFuture, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config: DEFAULT_STRATEGY_CONFIG })).not.toThrow();

    const result = generateCandidate({ quote: validRawQuote, now: farFuture, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.outcome).toBe("no-candidate");
    if (result.outcome === "no-candidate") {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });

  it("returns no-candidate with STALE_QUOTE for a schema-invalid quote, never throwing", () => {
    const result = generateCandidate({ quote: { not: "a quote" }, now: FRESH_NOW, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.outcome).toBe("no-candidate");
    if (result.outcome === "no-candidate") {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });
});

describe("generateCandidate — config is a programmer-error guard, not a diagnostic path", () => {
  const invalidConfigs: ReadonlyArray<readonly [string, Partial<StrategyConfig>]> = [
    ["zoneWidth is zero", { zoneWidth: decimalStringSchema.parse("0") }],
    ["invalidationOffset is negative-shaped (zero)", { invalidationOffset: decimalStringSchema.parse("0") }],
    ["trancheCount is zero", { trancheCount: 0 }],
    ["trancheCount is not an integer", { trancheCount: 1.5 }],
    ["expiryMs is zero", { expiryMs: 0 }],
    ["totalQuantity is zero", { totalQuantity: decimalStringSchema.parse("0") }],
    ["strategyId is empty", { strategyId: "" }],
  ];

  it.each(invalidConfigs)("throws for an invalid config: %s", (_name, override) => {
    const config: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, ...override };
    expect(() => generateCandidate({ quote: validRawQuote, now: FRESH_NOW, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config })).toThrow();
  });

  it("throws when pullback + zoneWidth + invalidationOffset would drive the invalidation price non-positive for the current ask — misconfiguration, not bad market data", () => {
    const config: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, pullback: decimalStringSchema.parse("500") };
    expect(() => generateCandidate({ quote: validRawQuote, now: FRESH_NOW, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config })).toThrow();
  });
});
