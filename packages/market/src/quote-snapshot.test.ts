import { describe, expect, it } from "vitest";

import { quoteSnapshotSchema } from "./quote-snapshot";
import { validRawQuote as validQuote } from "./test-support/quote-fixtures";

describe("quoteSnapshotSchema", () => {
  it("accepts a well-formed quote snapshot", () => {
    expect(quoteSnapshotSchema.safeParse(validQuote).success).toBe(true);
  });

  it("rejects a numeric bidPrice without throwing — a schema built on z.number() for a price field would silently reweaken the money guard this composition depends on", () => {
    const candidate = { ...validQuote, bidPrice: 250.0 };
    expect(() => quoteSnapshotSchema.safeParse(candidate)).not.toThrow();
    expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a numeric askQuantity without throwing", () => {
    const candidate = { ...validQuote, askQuantity: 50 };
    expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a snapshot missing timestamps entirely", () => {
    const withoutTimestamps: Record<string, unknown> = { ...validQuote };
    delete withoutTimestamps.timestamps;
    expect(quoteSnapshotSchema.safeParse(withoutTimestamps).success).toBe(false);
  });

  it("rejects a snapshot whose timestamps omit quoteAcquiredAt — freshness has nothing to age without it", () => {
    const candidate = { ...validQuote, timestamps: { ingestedAt: validQuote.timestamps.ingestedAt } };
    expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a schema-invalid decimal string (exponent notation) for a price field", () => {
    const candidate = { ...validQuote, askPrice: "2.5e2" };
    expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(["instrument-a", "BTC-USD"])(
    "rejects the ad hoc instrumentId %s without throwing — it was never derived from canonicalInstrumentId",
    (instrumentId) => {
      const candidate = { ...validQuote, instrumentId };
      expect(() => quoteSnapshotSchema.safeParse(candidate)).not.toThrow();
      expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
    },
  );
});

// Kills the "corrupt top-of-book liquidity marked executable" bug class:
// decimalStringSchema alone admits "-1", "0", and "0.00" (negative and
// zero amounts are legitimate elsewhere — a fee, a reservation — so it
// has no opinion on sign), but a quote cannot legitimately offer a
// non-positive price or size. All four money fields must reject all
// three non-positive spellings.
describe("quoteSnapshotSchema — positivity", () => {
  const moneyFields = ["bidPrice", "askPrice", "bidQuantity", "askQuantity"] as const;
  const nonPositiveValues = ["-1", "0", "0.00"];

  for (const field of moneyFields) {
    it.each(nonPositiveValues)(`rejects ${field} = %s (non-positive) without throwing`, (value) => {
      const candidate = { ...validQuote, [field]: value };
      expect(() => quoteSnapshotSchema.safeParse(candidate)).not.toThrow();
      expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(false);
    });

    it(`accepts a genuinely positive ${field}`, () => {
      const candidate = { ...validQuote, [field]: "0.01" };
      expect(quoteSnapshotSchema.safeParse(candidate).success).toBe(true);
    });
  }
});
