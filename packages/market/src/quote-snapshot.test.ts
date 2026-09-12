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
});
