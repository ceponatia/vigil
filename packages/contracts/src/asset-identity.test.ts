import { describe, expect, it } from "vitest";

import {
  ASSET_IDENTITY_KINDS,
  assetIdSchema,
  assetIdentitySchema,
  assetMetadataSchema,
  canonicalAssetId,
  compareAssetIdentity,
} from "./asset-identity";
import type { AssetIdentity } from "./asset-identity";
import type { ReasonCode } from "./reason-codes";

// Kills the "ticker as identity" bug class (docs/testing.md "Chain/contract/
// mint differs despite a matching ticker"): a naive symbol-keyed lookup
// would treat every row below as "the same asset, USDX" because it only
// looks at `symbol`. `AssetIdentity` and `compareAssetIdentity` must
// disagree with that lookup on every row: same ticker, different
// chain/contract/mint/withdrawal-network is always a mismatch, never
// silently merged.
const sameTickerDifferentIdentityCases: ReadonlyArray<{
  readonly name: string;
  readonly symbol: string;
  readonly declared: AssetIdentity;
  readonly resolved: AssetIdentity;
  readonly expectedReasonCode: ReasonCode;
}> = [
  {
    name: "same ticker, different chain, same native denomination string",
    symbol: "USDX",
    declared: assetIdentitySchema.parse({ kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" }),
    resolved: assetIdentitySchema.parse({ kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" }),
    expectedReasonCode: "WRONG_CHAIN",
  },
  {
    name: "same ticker, same chain, different contract address",
    symbol: "USDX",
    declared: assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-a", withdrawalNetwork: "ERC20" }),
    resolved: assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-b", withdrawalNetwork: "ERC20" }),
    expectedReasonCode: "UNAPPROVED_ASSET",
  },
  {
    name: "same ticker, same chain, contract declared but mint resolved (kind differs)",
    symbol: "USDX",
    declared: assetIdentitySchema.parse({ kind: "contract", chainId: "solana:mainnet-beta", contractAddress: "contract-address-c", withdrawalNetwork: "SPL" }),
    resolved: assetIdentitySchema.parse({ kind: "mint", chainId: "solana:mainnet-beta", mintAddress: "mint-address-c", withdrawalNetwork: "SPL" }),
    expectedReasonCode: "UNAPPROVED_ASSET",
  },
  {
    name: "same ticker, same chain, same contract, different withdrawal network",
    symbol: "USDX",
    declared: assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-d", withdrawalNetwork: "ERC20" }),
    resolved: assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-d", withdrawalNetwork: "ARBITRUM_ONE" }),
    expectedReasonCode: "UNAPPROVED_ASSET",
  },
  {
    // Reason-code precedence: when the chain AND the contract both differ,
    // the chain is what a caller must be told about first. An implementation
    // that compared the contract/mint value before the chain would answer
    // UNAPPROVED_ASSET here and hide the fact that the resolved asset is on
    // an entirely different chain (docs/policy.md, WRONG_CHAIN).
    name: "same ticker, different chain AND a different contract address",
    symbol: "USDX",
    declared: assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-e", withdrawalNetwork: "ERC20" }),
    resolved: assetIdentitySchema.parse({ kind: "contract", chainId: "137", contractAddress: "contract-address-f", withdrawalNetwork: "POLYGON" }),
    expectedReasonCode: "WRONG_CHAIN",
  },
];

describe("assetIdentitySchema", () => {
  it("accepts exactly one of contract, mint, or native per the ASSET_IDENTITY_KINDS registry", () => {
    for (const kind of ASSET_IDENTITY_KINDS) {
      const candidate =
        kind === "contract"
          ? { kind, chainId: "1", contractAddress: "contract-address", withdrawalNetwork: "ERC20" }
          : kind === "mint"
            ? { kind, chainId: "solana:mainnet-beta", mintAddress: "mint-address", withdrawalNetwork: "SPL" }
            : { kind, chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
      expect(assetIdentitySchema.safeParse(candidate).success).toBe(true);
    }
  });

  it("rejects an identity naming a ticker instead of a chain identifier field — proves the schema has no bare-ticker escape hatch", () => {
    const result = assetIdentitySchema.safeParse({ symbol: "USDX" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown kind without throwing", () => {
    expect(() =>
      assetIdentitySchema.safeParse({ kind: "ticker-only", chainId: "1", symbol: "USDX" }),
    ).not.toThrow();
    expect(assetIdentitySchema.safeParse({ kind: "ticker-only", chainId: "1", symbol: "USDX" }).success).toBe(false);
  });

  // A component containing the "|" canonicalAssetId uses as its separator
  // could otherwise let two distinct identities collide on one canonical
  // id: `contractAddress: "a|b", withdrawalNetwork: "c"` joins to the same
  // string as `contractAddress: "a", withdrawalNetwork: "b|c"`. The schema
  // now rejects the separator outright, so the assertion that matches the
  // code is "parsing rejects it without throwing" rather than "the two
  // derive different ids" — there is no id to derive from a value the
  // schema never accepts in the first place.
  it("rejects a contractAddress or withdrawalNetwork containing the reserved '|' separator, without throwing — a value that reached canonicalAssetId undetected could collide with a differently-split pair that joins to the same string", () => {
    const pipeInContractAddress = { kind: "contract", chainId: "1", contractAddress: "a|b", withdrawalNetwork: "c" };
    const pipeInWithdrawalNetwork = { kind: "contract", chainId: "1", contractAddress: "a", withdrawalNetwork: "b|c" };

    expect(() => assetIdentitySchema.safeParse(pipeInContractAddress)).not.toThrow();
    expect(() => assetIdentitySchema.safeParse(pipeInWithdrawalNetwork)).not.toThrow();
    expect(assetIdentitySchema.safeParse(pipeInContractAddress).success).toBe(false);
    expect(assetIdentitySchema.safeParse(pipeInWithdrawalNetwork).success).toBe(false);
  });

  it("rejects a chainId, mintAddress, or nativeDenomination containing the reserved '/' separator, without throwing — that character is reserved for @vigil/market's canonicalInstrumentId, one layer up", () => {
    const slashInChainId = { kind: "native", chainId: "1/337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
    const slashInMintAddress = { kind: "mint", chainId: "solana:mainnet-beta", mintAddress: "mint/address", withdrawalNetwork: "SPL" };

    expect(() => assetIdentitySchema.safeParse(slashInChainId)).not.toThrow();
    expect(assetIdentitySchema.safeParse(slashInChainId).success).toBe(false);
    expect(assetIdentitySchema.safeParse(slashInMintAddress).success).toBe(false);
  });

  it("declares exactly the ASSET_IDENTITY_KINDS registry as its discriminant values — a fourth kind added to the schema without updating the registry (or vice versa) would silently drop out of every test loop driven by ASSET_IDENTITY_KINDS", () => {
    const schemaKinds = assetIdentitySchema.options.map((option) => option.shape.kind.value).sort();
    expect(schemaKinds).toEqual([...ASSET_IDENTITY_KINDS].sort());
  });
});

// Kills the "ad hoc string branded as a valid asset id" bug class
// (packages/market/src/instrument-identity.ts's instrumentIdSchema
// depends on assetIdSchema correctly rejecting these, since it splits an
// instrument id on "/" and validates each half against this schema): a
// canonical asset id is not just "any non-empty string", it has the
// exact shape "chainId|kind|value|withdrawalNetwork".
describe("assetIdSchema", () => {
  it("accepts a value canonicalAssetId actually produces", () => {
    const identity = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
    expect(assetIdSchema.safeParse(canonicalAssetId(identity)).success).toBe(true);
  });

  const adHocStrings = ["instrument-a", "BTC-USD", "", "1|native|VGLBASE"];
  it.each(adHocStrings)("rejects the ad hoc string %s without throwing — it was never derived from an AssetIdentity", (value) => {
    expect(() => assetIdSchema.safeParse(value)).not.toThrow();
    expect(assetIdSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a value whose kind segment is not one of the ASSET_IDENTITY_KINDS registry members, even though it otherwise has four pipe-separated segments", () => {
    expect(assetIdSchema.safeParse("1|ticker|VGLBASE|ERC20").success).toBe(false);
  });
});

describe("canonicalAssetId", () => {
  it.each(sameTickerDifferentIdentityCases)(
    "$name — declared and resolved derive different canonical ids despite sharing the ticker $symbol",
    ({ declared, resolved }) => {
      expect(canonicalAssetId(declared)).not.toBe(canonicalAssetId(resolved));
    },
  );

  it("is deterministic: the same identity always derives the same id", () => {
    const identity = assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-stable", withdrawalNetwork: "ERC20" });
    // A second, independently-parsed value with the same fields — not a
    // spread copy of `identity` — so this proves value equality drives
    // the id, not object identity, without relying on how object spread
    // interacts with a branded AssetIdentity's type.
    const independentCopy = assetIdentitySchema.parse({ kind: "contract", chainId: "1", contractAddress: "contract-address-stable", withdrawalNetwork: "ERC20" });
    expect(canonicalAssetId(identity)).toBe(canonicalAssetId(independentCopy));
  });

  it("derives the id from the identity fields alone — a display ticker riding along on the input never reaches the id, so a renamed or re-used ticker can neither split one asset into two ids nor merge two assets into one", () => {
    // The excess `symbol` is exactly what a symbol-keyed lookup table
    // would hand in. assetIdentitySchema strips it during parsing (zod's
    // default "unknown keys are stripped" object behavior) before
    // canonicalAssetId ever sees the result — proven here by checking the
    // parsed value directly, since a raw object carrying `symbol` can no
    // longer be passed to canonicalAssetId at all (AssetIdentity is
    // branded; see the "cannot be constructed as a plain object literal"
    // test below for that compile-time guarantee).
    const withStrayTicker = assetIdentitySchema.parse({
      kind: "native",
      chainId: "1",
      nativeDenomination: "VGLBASE",
      withdrawalNetwork: "ERC20",
      symbol: "USDX",
    });
    const withoutTicker = assetIdentitySchema.parse({
      kind: "native",
      chainId: "1",
      nativeDenomination: "VGLBASE",
      withdrawalNetwork: "ERC20",
    });

    expect(withStrayTicker).not.toHaveProperty("symbol");
    expect(canonicalAssetId(withStrayTicker)).toBe(canonicalAssetId(withoutTicker));
    expect(canonicalAssetId(withStrayTicker)).not.toContain("USDX");
  });
});

describe("compareAssetIdentity", () => {
  it("reports a match for two structurally identical identities — the positive control for every mismatch case below", () => {
    const identity = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
    // A second, independently-parsed value with the same fields, not a
    // spread copy, for the same reason as canonicalAssetId's determinism
    // test above.
    const sameIdentity = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
    const result = compareAssetIdentity(identity, sameIdentity);
    expect(result.matches).toBe(true);
  });

  it.each(sameTickerDifferentIdentityCases)(
    "$name — rejected as a mismatch with reason code $expectedReasonCode, never merged by the shared ticker",
    ({ declared, resolved, expectedReasonCode }) => {
      const result = compareAssetIdentity(declared, resolved);
      expect(result.matches).toBe(false);
      if (!result.matches) {
        expect(result.reasonCode).toBe(expectedReasonCode);
        expect(result.detail.length).toBeGreaterThan(0);
      }
    },
  );

  it("never throws, including on the mismatch path — a mismatch is a reason-coded diagnostic, never an exception (docs/resilience.md §4)", () => {
    const a = assetIdentitySchema.parse({ kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" });
    const b = assetIdentitySchema.parse({ kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" });
    expect(() => compareAssetIdentity(a, b)).not.toThrow();
  });

  // Kills the "revalidate before joining" bug class: before AssetIdentity
  // was branded, canonicalAssetId and compareAssetIdentity accepted any
  // object literal typed AssetIdentity without ever running
  // withoutReservedSeparators — so a caller could bypass the schema
  // entirely and hand in a component containing "|", and
  // ("a|b","c")/("a","b|c") would both derive "1|contract|a|b|c". That
  // bypass is now a compile-time error, not just a schema-parse-time
  // rejection — the assignment below never gets to run with a value that
  // skipped validation, because no such value type-checks as
  // AssetIdentity any more.
  it("cannot be constructed as a plain object literal that skips validation — only assetIdentitySchema.parse can produce a value assignable to AssetIdentity, so canonicalAssetId and compareAssetIdentity can never see an unvalidated separator-carrying component", () => {
    // @ts-expect-error -- a plain object literal has no schema brand, so this assignment is a compile-time error even though every field name and type otherwise matches AssetIdentity
    const bypassed: AssetIdentity = { kind: "contract", chainId: "1", contractAddress: "a|b", withdrawalNetwork: "c" };
    const otherHalf = { kind: "contract", chainId: "1", contractAddress: "a", withdrawalNetwork: "b|c" };

    // The two lines above still run at runtime (ts-expect-error only
    // suppresses the compiler diagnostic); this is the reviewer's exact
    // "contractAddress carries the pipe" / "withdrawalNetwork carries the
    // pipe" pair — the two objects that would otherwise both derive
    // "1|contract|a|b|c". Both halves are refused by the schema — the
    // only gateway to an actual AssetIdentity — confirming the
    // compile-time guarantee above and the schema-level refinement agree
    // rather than one silently overriding the other.
    expect(assetIdentitySchema.safeParse(bypassed).success).toBe(false);
    expect(assetIdentitySchema.safeParse(otherHalf).success).toBe(false);
  });
});

describe("assetMetadataSchema", () => {
  it("accepts a canonical asset id paired with a display symbol", () => {
    const identity = assetIdentitySchema.parse({ kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" });
    const result = assetMetadataSchema.safeParse({ assetId: canonicalAssetId(identity), symbol: "VGL" });
    expect(result.success).toBe(true);
  });

  it("does not accept identity fields in place of assetId — symbol is metadata layered on TOP of a canonical id, not a substitute for one", () => {
    const result = assetMetadataSchema.safeParse({ chainId: "1", nativeDenomination: "USDX", symbol: "USDX" });
    expect(result.success).toBe(false);
  });

  it("two AssetMetadata records may legitimately share a symbol while resolving to different canonical ids — proves symbol collisions do not collapse identity at the metadata layer either", () => {
    const usdxOnEthereum = assetMetadataSchema.parse({
      assetId: canonicalAssetId(assetIdentitySchema.parse({ kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" })),
      symbol: "USDX",
    });
    const usdxOnPolygon = assetMetadataSchema.parse({
      assetId: canonicalAssetId(assetIdentitySchema.parse({ kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" })),
      symbol: "USDX",
    });

    expect(usdxOnEthereum.symbol).toBe(usdxOnPolygon.symbol);
    expect(usdxOnEthereum.assetId).not.toBe(usdxOnPolygon.assetId);
  });
});
