import { describe, expect, it } from "vitest";
import { assetIdentitySchema } from "@vigil/contracts";

import { canonicalInstrumentId, instrumentIdSchema, instrumentIdentitySchema } from "./instrument-identity";
import type { InstrumentIdentity } from "./instrument-identity";

const base = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
const quote = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
const otherQuote = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "OTHERQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" });

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
  it("rejects a base or quote asset whose nativeDenomination contains the reserved '/' separator, without throwing — canonicalInstrumentId joins two asset ids with '/', so this must be caught at the asset-identity layer before an instrument can be built at all", () => {
    const slashInBaseDenomination = {
      baseAsset: { kind: "native", chainId: "1337", nativeDenomination: "VGL/BASE", withdrawalNetwork: "SYNTHETIC_TESTNET" },
      quoteAsset: quote,
    };

    expect(() => instrumentIdentitySchema.safeParse(slashInBaseDenomination)).not.toThrow();
    expect(instrumentIdentitySchema.safeParse(slashInBaseDenomination).success).toBe(false);
  });

  // The instrument-identity analogue of asset-identity.test.ts's "cannot
  // be constructed as a plain object literal" test: before AssetIdentity
  // was branded, a raw object literal for baseAsset/quoteAsset — separator
  // and all — type-checked as InstrumentIdentity without ever running
  // asset-identity.ts's field refinements. That bypass is now a
  // compile-time error one layer below canonicalInstrumentId, not just a
  // schema-parse-time rejection.
  it("cannot bypass identity validation via a raw baseAsset/quoteAsset object literal either — AssetIdentity's brand rejects it at compile time, one layer below canonicalInstrumentId", () => {
    // @ts-expect-error -- baseAsset is a plain object literal with no schema brand, so this assignment is a compile-time error even though the shape (including the reserved "/" it carries) otherwise matches AssetIdentity
    const bypassed: InstrumentIdentity = { baseAsset: { kind: "native", chainId: "1337", nativeDenomination: "VGL/BASE", withdrawalNetwork: "SYNTHETIC_TESTNET" }, quoteAsset: quote };
    // Still runs at runtime; the composed schema is the only gateway to an
    // actual InstrumentIdentity, and it refuses the same value.
    expect(instrumentIdentitySchema.safeParse(bypassed).success).toBe(false);
  });
});

// Kills the "ad hoc string branded as a valid instrument id" bug class
// (this issue's P2 finding): instrumentIdSchema must not accept an
// arbitrary or ticker-only string just because it is non-empty.
describe("instrumentIdSchema", () => {
  const adHocStrings = ["instrument-a", "BTC-USD", "", "no-slash-at-all"];
  it.each(adHocStrings)("rejects the ad hoc string %s without throwing — it was never derived from canonicalInstrumentId", (value) => {
    expect(() => instrumentIdSchema.safeParse(value)).not.toThrow();
    expect(instrumentIdSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a string with a slash whose halves are not themselves canonical asset ids", () => {
    expect(instrumentIdSchema.safeParse("instrument-a/instrument-b").success).toBe(false);
  });

  it("accepts exactly the id canonicalInstrumentId derives for a real instrument", () => {
    const derived = canonicalInstrumentId({ baseAsset: base, quoteAsset: quote });
    expect(instrumentIdSchema.safeParse(derived).success).toBe(true);
  });
});

describe("canonicalInstrumentId", () => {
  it("is deterministic: the same base/quote pair always derives the same id", () => {
    const instrument: InstrumentIdentity = { baseAsset: base, quoteAsset: quote };
    // A second, independently-parsed pair with the same field values —
    // not a spread copy of `base`/`quote` — so this proves value equality
    // drives the id, not object identity, without relying on how object
    // spread interacts with a branded AssetIdentity's type.
    const independentCopy: InstrumentIdentity = {
      baseAsset: assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" }),
      quoteAsset: assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" }),
    };
    expect(canonicalInstrumentId(instrument)).toBe(canonicalInstrumentId(independentCopy));
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
