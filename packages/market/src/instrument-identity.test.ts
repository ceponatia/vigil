import { describe, expect, it } from "vitest";
import type { AssetIdentity } from "@vigil/contracts";

import { canonicalInstrumentId, instrumentIdentitySchema } from "./instrument-identity";
import type { InstrumentIdentity } from "./instrument-identity";

const base: AssetIdentity = { kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
const quote: AssetIdentity = { kind: "native", chainId: "1337", nativeDenomination: "VGLQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
const otherQuote: AssetIdentity = { kind: "native", chainId: "1337", nativeDenomination: "OTHERQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" };

describe("instrumentIdentitySchema", () => {
  it("accepts a base/quote pair of valid asset identities", () => {
    expect(instrumentIdentitySchema.safeParse({ baseAsset: base, quoteAsset: quote }).success).toBe(true);
  });

  it("rejects a pair missing a quote asset without throwing", () => {
    expect(() => instrumentIdentitySchema.safeParse({ baseAsset: base })).not.toThrow();
    expect(instrumentIdentitySchema.safeParse({ baseAsset: base }).success).toBe(false);
  });
});

describe("canonicalInstrumentId", () => {
  it("is deterministic: the same base/quote pair always derives the same id", () => {
    const instrument: InstrumentIdentity = { baseAsset: base, quoteAsset: quote };
    expect(canonicalInstrumentId(instrument)).toBe(canonicalInstrumentId({ baseAsset: { ...base }, quoteAsset: { ...quote } }));
  });

  it("derives a different id for a different quote asset on the same base", () => {
    const idA = canonicalInstrumentId({ baseAsset: base, quoteAsset: quote });
    const idB = canonicalInstrumentId({ baseAsset: base, quoteAsset: otherQuote });
    expect(idA).not.toBe(idB);
  });

  it("derives a different id when base and quote are swapped — the inverse route is a different instrument, not the same one written backwards", () => {
    const forward = canonicalInstrumentId({ baseAsset: base, quoteAsset: quote });
    const inverse = canonicalInstrumentId({ baseAsset: quote, quoteAsset: base });
    expect(forward).not.toBe(inverse);
  });
});
