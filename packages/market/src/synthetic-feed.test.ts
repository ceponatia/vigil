import { describe, expect, it } from "vitest";

import { SYNTHETIC_INSTRUMENT_ID, generateSyntheticQuotes } from "./synthetic-feed";
import { quoteSnapshotSchema } from "./quote-snapshot";

const PARAMS = { seed: 99, count: 10, startTimestamp: "2024-06-01T00:00:00.000Z" };

/**
 * Reads a rendered DecimalString back as exact integer base units, by
 * string surgery only — no Number(), no parseFloat. Only safe to compare
 * two values with each other once `fractionDigits` has confirmed they share
 * a scale, which is why both helpers exist together.
 */
const fractionDigits = (value: string): number => (value.split(".")[1] ?? "").length;
const baseUnits = (value: string): bigint => BigInt(value.replace(".", ""));

describe("generateSyntheticQuotes", () => {
  it("is deterministic: two calls with identical params produce deeply equal sequences", () => {
    const first = generateSyntheticQuotes(PARAMS);
    const second = generateSyntheticQuotes(PARAMS);
    expect(second).toEqual(first);
  });

  it("a different seed produces a different sequence", () => {
    const seeded = generateSyntheticQuotes(PARAMS);
    const differentSeed = generateSyntheticQuotes({ ...PARAMS, seed: PARAMS.seed + 1 });
    expect(differentSeed).not.toEqual(seeded);
  });

  it("returns exactly `count` quotes, and zero for count 0", () => {
    expect(generateSyntheticQuotes(PARAMS)).toHaveLength(PARAMS.count);
    expect(generateSyntheticQuotes({ ...PARAMS, count: 0 })).toHaveLength(0);
  });

  it("every generated quote is schema-valid — a construction bug that skipped the schema, or an integer-arithmetic bug that produced a malformed decimal string, would fail this", () => {
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      expect(quoteSnapshotSchema.safeParse(quote).success).toBe(true);
    }
  });

  it("every quote names the single synthetic instrument — this slice builds no second instrument", () => {
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      expect(quote.instrumentId).toBe(SYNTHETIC_INSTRUMENT_ID);
    }
  });

  it("askPrice is always strictly ABOVE bidPrice — a sign-flipped spread constant would produce a crossed book (ask below bid) that still passes a mere 'the two differ' check, and every downstream cost, edge, and fill calculation built on this fixture would be nonsense", () => {
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      // Compared as exact integer base units — never parsed as floats. Both
      // prices are rendered at the same fixed scale, so after asserting the
      // scales agree, dropping the decimal point is a lossless integer
      // comparison.
      expect(fractionDigits(quote.askPrice)).toBe(fractionDigits(quote.bidPrice));
      expect(baseUnits(quote.askPrice)).toBeGreaterThan(baseUnits(quote.bidPrice));
    }
  });

  it("ingestedAt is always at or after quoteAcquiredAt for every quote — ingestion cannot precede acquisition", () => {
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      const acquired = Date.parse(quote.timestamps.quoteAcquiredAt);
      const ingested = Date.parse(quote.timestamps.ingestedAt);
      expect(ingested).toBeGreaterThan(acquired);
    }
  });

  it("quoteAcquiredAt strictly increases from one tick to the next — a generator that reused or read the current clock instead of walking the injected start time would fail this", () => {
    let previousMs: number | null = null;
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      const currentMs = Date.parse(quote.timestamps.quoteAcquiredAt);
      if (previousMs !== null) {
        expect(currentMs).toBeGreaterThan(previousMs);
      }
      previousMs = currentMs;
    }
  });
});
