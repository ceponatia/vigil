import { describe, expect, it } from "vitest";
import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp } from "@vigil/contracts";

import { evaluateQuoteFreshness } from "./freshness";
import { validRawQuote as validQuote } from "./test-support/quote-fixtures";

const parse = (value: string): IsoUtcTimestamp => isoUtcTimestampSchema.parse(value);

const MAX_AGE_MS = 5_000;

// Kills the "stale quote silently treated as executable" bug class
// (docs/testing.md "Quote/book is stale or corrupt"; this issue's
// acceptance item 2): a quote snapshot older than its configured
// freshness threshold must produce STALE_QUOTE and never look executable.
describe("evaluateQuoteFreshness — staleness", () => {
  it("is executable when the quote is well within the freshness threshold", () => {
    const now = parse("2024-01-01T00:00:02.000Z"); // 2s old, threshold is 5s
    const result = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(true);
    if (result.executable) {
      expect(result.ageMs).toBe(2000);
    }
  });

  it("is still executable exactly at the freshness threshold — 'older than' is a strict inequality, so the boundary itself is not yet stale", () => {
    const now = parse("2024-01-01T00:00:05.000Z"); // exactly 5000ms old
    const result = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(true);
  });

  it("produces STALE_QUOTE the instant a quote is older than its threshold — a boundary off-by-one here would let one config's threshold silently mean 'threshold + 1ms'", () => {
    const now = parse("2024-01-01T00:00:05.001Z"); // 5001ms old
    const result = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it("produces STALE_QUOTE for a quote far older than its threshold and blocks new risk downstream — the executable:false shape carries no usable quote for a caller to act on", () => {
    const now = parse("2024-01-01T01:00:00.000Z"); // one hour old
    const result = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: MAX_AGE_MS });
    expect(result).toEqual({
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: expect.stringContaining("exceeding the configured"),
    });
  });

  it("never throws for a stale input, however old", () => {
    const now = parse("2999-01-01T00:00:00.000Z");
    expect(() => evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: MAX_AGE_MS })).not.toThrow();
  });
});

describe("evaluateQuoteFreshness — corruption and schema-invalid input", () => {
  const now = parse("2024-01-01T00:00:01.000Z");

  const corruptCases: ReadonlyArray<{ readonly name: string; readonly raw: unknown }> = [
    { name: "null", raw: null },
    { name: "undefined", raw: undefined },
    { name: "an array instead of an object", raw: [] },
    { name: "a bidPrice that is a JS number, not a DecimalString", raw: { ...validQuote, bidPrice: 250 } },
    { name: "missing timestamps entirely", raw: { ...validQuote, timestamps: undefined } },
    { name: "a quoteAcquiredAt that is not a valid ISO-8601 UTC string", raw: { ...validQuote, timestamps: { ...validQuote.timestamps, quoteAcquiredAt: "not-a-timestamp" } } },
  ];

  it.each(corruptCases)("$name is treated as unusable input: non-executable, STALE_QUOTE, never thrown", ({ raw }) => {
    expect(() => evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS })).not.toThrow();

    const result = evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });

  it("treats a future-dated quote-acquisition timestamp as corrupt, not as unusually fresh", () => {
    const pastNow = parse("2024-01-01T00:00:00.000Z");
    const result = evaluateQuoteFreshness({ raw: validQuote, now: pastNow, maxAgeMs: MAX_AGE_MS });
    // validQuote's quoteAcquiredAt is 2024-01-01T00:00:00.000Z; use a "now"
    // strictly before it to force a negative age.
    const earlierNow = parse("2023-12-31T23:59:59.000Z");
    const negativeAgeResult = evaluateQuoteFreshness({ raw: validQuote, now: earlierNow, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(true); // sanity: pastNow === acquisition time is age 0, not negative
    expect(negativeAgeResult.executable).toBe(false);
    if (!negativeAgeResult.executable) {
      expect(negativeAgeResult.reasonCode).toBe("STALE_QUOTE");
      expect(negativeAgeResult.detail).toContain("after");
    }
  });
});
