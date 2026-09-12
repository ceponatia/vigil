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
    // Asserted field by field, rather than via `toEqual({ ..., detail:
    // expect.stringContaining(...) })`: vitest types `stringContaining`'s
    // return as `any`, and embedding it as an object-literal property
    // trips `@typescript-eslint/no-unsafe-assignment` on that property.
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
      expect(result.detail).toContain("exceeding the configured");
    }
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
    { name: "a non-positive bidQuantity (corrupt top-of-book liquidity)", raw: { ...validQuote, bidQuantity: "0" } },
    { name: "an ad hoc instrumentId never derived from canonicalInstrumentId", raw: { ...validQuote, instrumentId: "instrument-a" } },
  ];

  it.each(corruptCases)("$name is treated as unusable input: non-executable, STALE_QUOTE, never thrown", ({ raw }) => {
    expect(() => evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS })).not.toThrow();

    const result = evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });

  // The owning matrix (all four money fields, all three non-positive
  // spellings) lives in quote-snapshot.test.ts, where quoteSnapshotSchema's
  // positivity refinement is defined — this proves only that
  // evaluateQuoteFreshness is correctly wired to that refinement for
  // every field, and that the STALE_QUOTE detail names whichever one
  // failed.
  it("blocks every non-positive price/quantity field, naming the offending field in the detail", () => {
    const moneyFields = ["bidPrice", "askPrice", "bidQuantity", "askQuantity"] as const;
    const nonPositiveValues = ["-1", "0", "0.00"];

    for (const field of moneyFields) {
      for (const value of nonPositiveValues) {
        const raw = { ...validQuote, [field]: value };
        const result = evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS });
        expect(result.executable).toBe(false);
        if (!result.executable) {
          expect(result.reasonCode).toBe("STALE_QUOTE");
          expect(result.detail).toContain(field);
        }
      }
    }
  });

  it("treats a future-dated quote-acquisition timestamp as corrupt, not as unusually fresh", () => {
    // validQuote's quoteAcquiredAt is 2024-01-01T00:00:00.000Z and its
    // ingestedAt is 250ms later — use a "now" at or after ingestedAt so
    // this sanity check exercises only the quoteAcquiredAt-vs-now
    // comparison, not the separate ingestedAt-vs-now provenance check
    // below.
    const atIngestion = parse("2024-01-01T00:00:00.250Z");
    const result = evaluateQuoteFreshness({ raw: validQuote, now: atIngestion, maxAgeMs: MAX_AGE_MS });
    // validQuote's quoteAcquiredAt is 2024-01-01T00:00:00.000Z; use a "now"
    // strictly before it to force a negative age.
    const earlierNow = parse("2023-12-31T23:59:59.000Z");
    const negativeAgeResult = evaluateQuoteFreshness({ raw: validQuote, now: earlierNow, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(true); // sanity: now at or after acquisition is a positive age, not negative
    expect(negativeAgeResult.executable).toBe(false);
    if (!negativeAgeResult.executable) {
      expect(negativeAgeResult.reasonCode).toBe("STALE_QUOTE");
      expect(negativeAgeResult.detail).toContain("after");
    }
  });

  it("treats a NaN maxAgeMs as corrupt configuration — a naive `age > maxAgeMs` comparison is false whenever maxAgeMs is NaN, which would fail OPEN (every quote looks fresh) rather than closed", () => {
    const result = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: Number.NaN });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });

  it("treats an infinite or negative maxAgeMs as corrupt configuration, not as 'nothing is ever stale' or 'everything is always stale'", () => {
    const infiniteResult = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: Number.POSITIVE_INFINITY });
    const negativeResult = evaluateQuoteFreshness({ raw: validQuote, now, maxAgeMs: -1 });
    expect(infiniteResult.executable).toBe(false);
    expect(negativeResult.executable).toBe(false);
  });

  it('treats an unparseable "now" as corrupt, not as "always fresh" — only reachable through a cast that bypasses the IsoUtcTimestamp brand, since ageMs("now" unparseable) is NaN and `NaN > maxAgeMs` is false', () => {
    const badNow = "not-a-timestamp" as unknown as IsoUtcTimestamp;
    const result = evaluateQuoteFreshness({ raw: validQuote, now: badNow, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
    }
  });

  it("treats ingestedAt earlier than quoteAcquiredAt as corrupt provenance — ingestion cannot precede acquisition (docs/evaluation.md \"Point-in-time integrity\")", () => {
    const raw = {
      ...validQuote,
      timestamps: { quoteAcquiredAt: validQuote.timestamps.quoteAcquiredAt, ingestedAt: "2023-12-31T23:59:59.000Z" },
    };
    const result = evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
      expect(result.detail).toContain("precedes");
    }
  });

  it('treats ingestedAt later than "now" as corrupt provenance — ingestion cannot happen in the future relative to the evaluation time', () => {
    const raw = {
      ...validQuote,
      timestamps: { quoteAcquiredAt: validQuote.timestamps.quoteAcquiredAt, ingestedAt: "2024-01-01T00:00:05.000Z" },
    };
    const result = evaluateQuoteFreshness({ raw, now, maxAgeMs: MAX_AGE_MS });
    expect(result.executable).toBe(false);
    if (!result.executable) {
      expect(result.reasonCode).toBe("STALE_QUOTE");
      expect(result.detail).toContain("after");
    }
  });
});
