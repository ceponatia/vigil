import { describe, expect, it } from "vitest";
import { generateSyntheticQuotes, quoteSnapshotSchema } from "@vigil/market";

import { SYNTHETIC_MARKET_EXPECTED_QUOTES, SYNTHETIC_MARKET_FIXTURE_PARAMS } from "../fixtures/synthetic-market";

// Kills the "non-reproducible synthetic feed" bug class (this issue's
// acceptance item 3): a deterministic synthetic fixture under
// tests/fixtures/ must reproduce the same sequence of quotes on repeated
// replay. A generator that reads Math.random(), Date.now(), or any other
// unseeded source — or one whose PRNG state leaks across calls — would
// fail one or more of the checks below.
describe("synthetic market replay (BOOT-03)", () => {
  it("reproduces the exact recorded fixture sequence on replay", () => {
    const actual = generateSyntheticQuotes(SYNTHETIC_MARKET_FIXTURE_PARAMS);
    expect(actual).toEqual(SYNTHETIC_MARKET_EXPECTED_QUOTES);
  });

  it("reproduces an identical sequence on a second, independent replay — proves the generator is a pure function of its parameters, not one with hidden state that advances across calls", () => {
    const first = generateSyntheticQuotes(SYNTHETIC_MARKET_FIXTURE_PARAMS);
    const second = generateSyntheticQuotes(SYNTHETIC_MARKET_FIXTURE_PARAMS);
    expect(second).toEqual(first);
    expect(second).toEqual(SYNTHETIC_MARKET_EXPECTED_QUOTES);
  });

  it("reproduces the same sequence a third time from a freshly constructed generator instance, confirming no cross-call or cross-instance leakage", () => {
    const third = generateSyntheticQuotes({ ...SYNTHETIC_MARKET_FIXTURE_PARAMS });
    expect(third).toEqual(SYNTHETIC_MARKET_EXPECTED_QUOTES);
  });

  it("every recorded quote in the fixture is schema-valid — catches a fixture that was hand-edited into a shape the live generator could never actually produce", () => {
    for (const quote of SYNTHETIC_MARKET_EXPECTED_QUOTES) {
      expect(quoteSnapshotSchema.safeParse(quote).success).toBe(true);
    }
  });

  it("a different seed produces a different sequence — proves the recorded sequence actually depends on the seed rather than being a fixed constant the generator always returns", () => {
    const alternate = generateSyntheticQuotes({
      ...SYNTHETIC_MARKET_FIXTURE_PARAMS,
      seed: SYNTHETIC_MARKET_FIXTURE_PARAMS.seed + 1,
    });
    expect(alternate).not.toEqual(SYNTHETIC_MARKET_EXPECTED_QUOTES);
  });

  it("a different count changes only the sequence length, and every extra quote continues to be schema-valid", () => {
    const shorter = generateSyntheticQuotes({ ...SYNTHETIC_MARKET_FIXTURE_PARAMS, count: SYNTHETIC_MARKET_FIXTURE_PARAMS.count - 1 });
    expect(shorter).toEqual(SYNTHETIC_MARKET_EXPECTED_QUOTES.slice(0, -1));
  });
});
