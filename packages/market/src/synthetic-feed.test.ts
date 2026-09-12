import { describe, expect, it } from "vitest";

import { SYNTHETIC_INSTRUMENT_ID, generateSyntheticQuotes } from "./synthetic-feed";
import { quoteSnapshotSchema } from "./quote-snapshot";

const PARAMS = { seed: 99, count: 10, startTimestamp: "2024-06-01T00:00:00.000Z" };

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

  it("askPrice is always different from bidPrice — the generator applies a non-zero spread on every tick", () => {
    for (const quote of generateSyntheticQuotes(PARAMS)) {
      expect(quote.askPrice).not.toBe(quote.bidPrice);
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
