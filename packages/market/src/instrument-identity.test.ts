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

  // The analogous instrument-level case for asset-identity.test.ts's
  // reserved-separator rejections: canonicalInstrumentId joins two
  // canonicalAssetId outputs with "/", so a "/" inside an underlying asset
  // component is rejected at the asset-identity layer before an instrument
  // could ever be built from it — proven here through the composed
  // instrumentIdentitySchema rather than re-implemented.
  it("rejects a base or quote asset whose nativeDenomination contains the reserved "/" separator, without throwing — canonicalInstrumentId joins two asset ids with "/", so this must be caught at the asset-identity layer before an instrument can be built at all", () => {
    const slashInBaseDenomination = {
      baseAsset: { kind: "native", chainId: "1337", nativeDenomination: "VGL/BASE", withdrawalNetwork: "SYNTHETIC_TESTNET" },
      quoteAsset: quote,
    };

    expect(() => instrumentIdentitySchema.safeParse(slashInBaseDenomination)).not.toThrow();
    expect(instrumentIdentitySchema.safeParse(slashInBaseDenomination).success).toBe(false);
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
