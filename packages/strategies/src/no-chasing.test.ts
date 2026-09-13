import { describe, expect, it } from "vitest";
import { decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";

import type { Candidate } from "./candidate";
import { DEFAULT_STRATEGY_CONFIG, generateCandidate } from "./candidate";
import { CANDIDATE_OUTCOMES, evaluateEntry } from "./no-chasing";
import { addDecimal, subtractDecimal } from "./scaled-decimal";
import { validRawQuote } from "./test-support/quote-fixtures";

const ts = (value: string): IsoUtcTimestamp => isoUtcTimestampSchema.parse(value);
const MAX_QUOTE_AGE_MS = 5_000;
const GENERATED_AT = ts("2024-01-01T00:00:01.000Z"); // 1s after validRawQuote's quoteAcquiredAt

/** A quote at `askPrice`, acquired at `quoteAcquiredAt` with no ingestion lag — good enough for a freshness check that only cares about age relative to `now`. */
function quoteAt(askPrice: DecimalString, quoteAcquiredAt: string): unknown {
  return { ...validRawQuote, askPrice, timestamps: { quoteAcquiredAt, ingestedAt: quoteAcquiredAt } };
}

function baseCandidate(): Candidate {
  const result = generateCandidate({ quote: validRawQuote, now: GENERATED_AT, maxQuoteAgeMs: MAX_QUOTE_AGE_MS, config: DEFAULT_STRATEGY_CONFIG });
  if (result.outcome !== "candidate") {
    throw new Error(`test setup failed: expected a candidate, got ${result.reasonCode}`);
  }
  return result.candidate;
}

// Acceptance item 2 / docs/testing.md "Entry discipline": "Attractive
// historical low; current executable price outside the approved entry
// zone" → "WAIT/MISSED; no late chasing trade". Kills the bug class this
// whole package exists to prevent: re-deriving a fresh entry zone (or
// worse, an ENTRY_ELIGIBLE/BUY) from today's price instead of honoring
// the zone the candidate was actually approved against.
describe("evaluateEntry — the attractive historical low never gets chased", () => {
  it("a much higher current ask than the zone that attracted the candidate returns MISSED/OUTSIDE_ENTRY_ZONE, never BUY or ENTRY_ELIGIBLE", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z"); // well within expiry, well after generation
    const muchHigherAsk = decimalStringSchema.parse("260.00"); // far beyond max + allowedExtension (249.10)
    const quote = quoteAt(muchHigherAsk, "2024-01-01T00:59:59.000Z");

    const { candidate: returnedCandidate, evaluation } = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });

    expect(evaluation.outcome).toBe("MISSED");
    expect(evaluation.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
    expect(returnedCandidate).toBe(candidate); // identity preserved
    expect(returnedCandidate.entryZone).toEqual(candidate.entryZone); // zone untouched
  });

  it("never returns ENTRY_ELIGIBLE for any price outside the approved zone, across a grid spanning below invalidation through beyond the allowed extension", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    const acquiredAt = "2024-01-01T00:59:59.000Z";

    const outsidePrices: readonly DecimalString[] = [
      subtractDecimal(candidate.invalidationPrice, decimalStringSchema.parse("1.00")), // below invalidation
      candidate.invalidationPrice, // exactly at invalidation (not yet invalidated: WAIT)
      addDecimal(candidate.invalidationPrice, decimalStringSchema.parse("0.50")), // between invalidation and min
      addDecimal(candidate.entryZone.max, decimalStringSchema.parse("0.50")), // above max, within extension
      addDecimal(candidate.entryZone.max, candidate.allowedExtension), // exactly at the extension boundary
      addDecimal(candidate.entryZone.max, decimalStringSchema.parse("5.00")), // beyond the extension
    ];

    for (const askPrice of outsidePrices) {
      const quote = quoteAt(askPrice, acquiredAt);
      const { evaluation } = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
      expect(evaluation.outcome).not.toBe("ENTRY_ELIGIBLE");
      expect(["WAIT", "MISSED"]).toContain(evaluation.outcome);
      expect(evaluation.reasonCode).not.toBeNull();
    }
  });
});

// Acceptance item 3: "An expired candidate returns MISSED with
// RESEARCH_EXPIRED, and the original entry zone and reason are preserved
// on the record rather than discarded." The decision table checks expiry
// before the zone at all, so this must hold even when the current ask
// would otherwise be squarely inside the zone.
describe("evaluateEntry — expiry", () => {
  it("returns MISSED/RESEARCH_EXPIRED once now is after expiresAt, even when the ask is inside the original zone, and preserves the zone on the record", () => {
    const candidate = baseCandidate();
    const afterExpiry = ts(new Date(Date.parse(candidate.expiresAt) + 1_000).toISOString());
    const quote = quoteAt(candidate.entryZone.min, new Date(Date.parse(afterExpiry) - 1_000).toISOString());

    const { candidate: returnedCandidate, evaluation } = evaluateEntry({ candidate, quote, now: afterExpiry, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });

    expect(evaluation.outcome).toBe("MISSED");
    expect(evaluation.reasonCode).toBe("RESEARCH_EXPIRED");
    expect(evaluation.detail.length).toBeGreaterThan(0);
    // The zone and the reason are preserved, not discarded: the candidate
    // handed back still carries its original entryZone and invalidationPrice.
    expect(returnedCandidate.entryZone).toEqual(candidate.entryZone);
    expect(returnedCandidate.invalidationPrice).toBe(candidate.invalidationPrice);
    expect(returnedCandidate).toBe(candidate);
  });

  it("is not yet expired exactly at expiresAt — the boundary belongs to the candidate, not to expiry", () => {
    const candidate = baseCandidate();
    const quote = quoteAt(candidate.entryZone.min, new Date(Date.parse(candidate.expiresAt) - 1_000).toISOString());
    const { evaluation } = evaluateEntry({ candidate, quote, now: candidate.expiresAt, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    expect(evaluation.outcome).not.toBe("MISSED");
  });
});

// Acceptance item 4: the decision table's remaining rows.
describe("evaluateEntry — the rest of the decision table", () => {
  it("BLOCKED with STALE_QUOTE for a quote older than maxQuoteAgeMs, before any zone/expiry logic runs", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    const staleQuote = quoteAt(candidate.entryZone.min, "2024-01-01T00:00:00.000Z"); // an hour old
    const { evaluation, candidate: returnedCandidate } = evaluateEntry({ candidate, quote: staleQuote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    expect(evaluation.outcome).toBe("BLOCKED");
    expect(evaluation.reasonCode).toBe("STALE_QUOTE");
    expect(evaluation.executablePrice).toBeNull();
    expect(evaluation.quoteAcquiredAt).toBeNull();
    expect(returnedCandidate).toBe(candidate);
  });

  it("BLOCKED with STALE_QUOTE for a schema-invalid quote, never throwing", () => {
    const candidate = baseCandidate();
    expect(() => evaluateEntry({ candidate, quote: { garbage: true }, now: GENERATED_AT, maxQuoteAgeMs: MAX_QUOTE_AGE_MS })).not.toThrow();
    const { evaluation } = evaluateEntry({ candidate, quote: { garbage: true }, now: GENERATED_AT, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    expect(evaluation.outcome).toBe("BLOCKED");
    expect(evaluation.reasonCode).toBe("STALE_QUOTE");
  });

  it("MISSED with THESIS_INVALIDATED once the ask drops below the invalidation price", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    const invalidatedAsk = subtractDecimal(candidate.invalidationPrice, decimalStringSchema.parse("0.01"));
    const quote = quoteAt(invalidatedAsk, "2024-01-01T00:59:59.000Z");
    const { evaluation } = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    expect(evaluation.outcome).toBe("MISSED");
    expect(evaluation.reasonCode).toBe("THESIS_INVALIDATED");
    expect(evaluation.executablePrice).toBe(invalidatedAsk);
  });

  it("is still WAIT exactly at max + allowedExtension, and MISSED the instant it goes one cent beyond — an off-by-one here would silently chase or silently give up one row early", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    const acquiredAt = "2024-01-01T00:59:59.000Z";
    const extendedMax = addDecimal(candidate.entryZone.max, candidate.allowedExtension);
    const justBeyond = addDecimal(extendedMax, decimalStringSchema.parse("0.01"));

    const atBoundary = evaluateEntry({ candidate, quote: quoteAt(extendedMax, acquiredAt), now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    const beyondBoundary = evaluateEntry({ candidate, quote: quoteAt(justBeyond, acquiredAt), now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });

    expect(atBoundary.evaluation.outcome).toBe("WAIT");
    expect(beyondBoundary.evaluation.outcome).toBe("MISSED");
    expect(atBoundary.evaluation.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
    expect(beyondBoundary.evaluation.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
  });

  it("ENTRY_ELIGIBLE with a null reasonCode for an ask inside the zone, at both boundaries and in the middle", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    for (const askPrice of [candidate.entryZone.min, candidate.entryZone.max, addDecimal(candidate.entryZone.min, decimalStringSchema.parse("1.00"))]) {
      const quote = quoteAt(askPrice, "2024-01-01T00:59:59.000Z");
      const { evaluation } = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
      expect(evaluation.outcome).toBe("ENTRY_ELIGIBLE");
      expect(evaluation.reasonCode).toBeNull();
      expect(evaluation.executablePrice).toBe(askPrice);
    }
  });

  it("CANDIDATE_OUTCOMES is exactly the four-member vocabulary this decision table produces — no BUY, no fifth state", () => {
    expect(CANDIDATE_OUTCOMES).toEqual(["ENTRY_ELIGIBLE", "WAIT", "MISSED", "BLOCKED"]);
  });
});

describe("evaluateEntry — determinism", () => {
  it("two calls with identical params produce identical evaluation ids", () => {
    const candidate = baseCandidate();
    const laterNow = ts("2024-01-01T01:00:00.000Z");
    const quote = quoteAt(candidate.entryZone.min, "2024-01-01T00:59:59.000Z");
    const first = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    const second = evaluateEntry({ candidate, quote, now: laterNow, maxQuoteAgeMs: MAX_QUOTE_AGE_MS });
    expect(second.evaluation).toEqual(first.evaluation);
    expect(second.evaluation.evaluationId).toBe(first.evaluation.evaluationId);
    expect(second.evaluation.idempotencyKey).toBe(first.evaluation.idempotencyKey);
  });
});
