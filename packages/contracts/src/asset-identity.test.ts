import { describe, expect, it } from "vitest";

import {
  ASSET_IDENTITY_KINDS,
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
    declared: { kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" },
    resolved: { kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" },
    expectedReasonCode: "WRONG_CHAIN",
  },
  {
    name: "same ticker, same chain, different contract address",
    symbol: "USDX",
    declared: { kind: "contract", chainId: "1", contractAddress: "contract-address-a", withdrawalNetwork: "ERC20" },
    resolved: { kind: "contract", chainId: "1", contractAddress: "contract-address-b", withdrawalNetwork: "ERC20" },
    expectedReasonCode: "UNAPPROVED_ASSET",
  },
  {
    name: "same ticker, same chain, contract declared but mint resolved (kind differs)",
    symbol: "USDX",
    declared: { kind: "contract", chainId: "solana:mainnet-beta", contractAddress: "contract-address-c", withdrawalNetwork: "SPL" },
    resolved: { kind: "mint", chainId: "solana:mainnet-beta", mintAddress: "mint-address-c", withdrawalNetwork: "SPL" },
    expectedReasonCode: "UNAPPROVED_ASSET",
  },
  {
    name: "same ticker, same chain, same contract, different withdrawal network",
    symbol: "USDX",
    declared: { kind: "contract", chainId: "1", contractAddress: "contract-address-d", withdrawalNetwork: "ERC20" },
    resolved: { kind: "contract", chainId: "1", contractAddress: "contract-address-d", withdrawalNetwork: "ARBITRUM_ONE" },
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
    declared: { kind: "contract", chainId: "1", contractAddress: "contract-address-e", withdrawalNetwork: "ERC20" },
    resolved: { kind: "contract", chainId: "137", contractAddress: "contract-address-f", withdrawalNetwork: "POLYGON" },
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
});

describe("canonicalAssetId", () => {
  it.each(sameTickerDifferentIdentityCases)(
    "$name — declared and resolved derive different canonical ids despite sharing the ticker $symbol",
    ({ declared, resolved }) => {
      expect(canonicalAssetId(declared)).not.toBe(canonicalAssetId(resolved));
    },
  );

  it("is deterministic: the same identity always derives the same id", () => {
    const identity: AssetIdentity = { kind: "contract", chainId: "1", contractAddress: "contract-address-stable", withdrawalNetwork: "ERC20" };
    expect(canonicalAssetId(identity)).toBe(canonicalAssetId({ ...identity }));
  });

  it("derives the id from the identity fields alone — a display ticker riding along on the object never reaches the id, so a renamed or re-used ticker can neither split one asset into two ids nor merge two assets into one", () => {
    // Typed loosely on purpose: the excess `symbol` is exactly what a
    // symbol-keyed lookup table would hand in, and the point is that the id
    // derivation must ignore it rather than fold it in.
    const withStrayTicker = {
      kind: "native" as const,
      chainId: "1",
      nativeDenomination: "VGLBASE",
      withdrawalNetwork: "ERC20",
      symbol: "USDX",
    };
    const withoutTicker: AssetIdentity = {
      kind: "native",
      chainId: "1",
      nativeDenomination: "VGLBASE",
      withdrawalNetwork: "ERC20",
    };

    expect(canonicalAssetId(withStrayTicker)).toBe(canonicalAssetId(withoutTicker));
    expect(canonicalAssetId(withStrayTicker)).not.toContain("USDX");
  });
});

describe("compareAssetIdentity", () => {
  it("reports a match for two structurally identical identities — the positive control for every mismatch case below", () => {
    const identity: AssetIdentity = { kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
    const result = compareAssetIdentity(identity, { ...identity });
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
    const a: AssetIdentity = { kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" };
    const b: AssetIdentity = { kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" };
    expect(() => compareAssetIdentity(a, b)).not.toThrow();
  });
});

describe("assetMetadataSchema", () => {
  it("accepts a canonical asset id paired with a display symbol", () => {
    const identity: AssetIdentity = { kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" };
    const result = assetMetadataSchema.safeParse({ assetId: canonicalAssetId(identity), symbol: "VGL" });
    expect(result.success).toBe(true);
  });

  it("does not accept identity fields in place of assetId — symbol is metadata layered on TOP of a canonical id, not a substitute for one", () => {
    const result = assetMetadataSchema.safeParse({ chainId: "1", nativeDenomination: "USDX", symbol: "USDX" });
    expect(result.success).toBe(false);
  });

  it("two AssetMetadata records may legitimately share a symbol while resolving to different canonical ids — proves symbol collisions do not collapse identity at the metadata layer either", () => {
    const usdxOnEthereum = assetMetadataSchema.parse({
      assetId: canonicalAssetId({ kind: "native", chainId: "1", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" }),
      symbol: "USDX",
    });
    const usdxOnPolygon = assetMetadataSchema.parse({
      assetId: canonicalAssetId({ kind: "native", chainId: "137", nativeDenomination: "USDX", withdrawalNetwork: "ERC20" }),
      symbol: "USDX",
    });

    expect(usdxOnEthereum.symbol).toBe(usdxOnPolygon.symbol);
    expect(usdxOnEthereum.assetId).not.toBe(usdxOnPolygon.assetId);
  });
});
