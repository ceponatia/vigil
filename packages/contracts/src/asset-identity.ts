import { z } from "zod";

import type { ReasonCode } from "./reason-codes";

/**
 * asset-identity.ts — canonical, chain-aware asset identity
 * (docs/capabilities.md "On-chain identity rules"; docs/testing.md
 * "Chain/contract/mint differs despite a matching ticker").
 *
 * Kills the "ticker as identity" bug class: a symbol/ticker is display
 * metadata, never identity. Two assets that would display the same ticker
 * but live on different chains, or carry different contract/mint/native
 * identifiers on the same chain, or share everything except the
 * withdrawal network, are different assets and must be rejected as
 * distinct rather than silently merged by a symbol lookup. This module
 * models identity as chain + exactly one of {contract address, mint
 * address, native denomination} + withdrawal network, and provides a
 * canonical id plus a reason-coded mismatch check so no caller has to
 * hand-roll (and get wrong) that comparison.
 *
 * ## Chain identifier convention
 *
 * `chainId` is always a plain, non-empty string on the wire. This package
 * picks one representation per chain family and documents it here rather
 * than encoding a family-specific format in the schema (chain identifier
 * conventions are numerous and this package has no need to parse them):
 *
 * - **EVM chains** — the decimal EIP-155 chain id, e.g. `"1"` (Ethereum
 *   mainnet), `"137"` (Polygon). `"1337"` is reserved in this codebase for
 *   the synthetic/local test chain used by `@vigil/market`'s fixtures —
 *   never a production chain.
 * - **Solana** — a namespaced id, `"solana:<cluster-or-genesis-id>"`.
 * - **Cosmos** — a namespaced id, `"cosmos:<chain-name>"`.
 *
 * ## What this module deliberately does not do
 *
 * - Normalize address casing (e.g. EVM checksum vs. lowercase). Callers
 *   are expected to hand in an already-normalized address; two different
 *   spellings of the same on-chain address are NOT reconciled here — that
 *   is a follow-up for whichever slice first ingests live chain data.
 * - Validate a chain family's address format. `contractAddress` and
 *   `mintAddress` are non-empty strings, nothing more.
 * - Resolve or validate a symbol/ticker against any registry. See
 *   `AssetMetadata` below, which is explicitly kept separate from
 *   identity.
 */

/**
 * Both characters below are reserved as canonical-id separators:
 * `canonicalAssetId` joins its components with `|`, and
 * `@vigil/market`'s `canonicalInstrumentId` joins two asset ids with `/`.
 * A component value containing either one could make two distinct
 * identities derive the same canonical id (e.g. `contractAddress: "a|b",
 * withdrawalNetwork: "c"` colliding with `contractAddress: "a",
 * withdrawalNetwork: "b|c"`), or make a canonical asset id itself
 * ambiguous inside a canonical instrument id. Every identity component
 * field is therefore constrained to exclude both characters, here in
 * `@vigil/contracts` rather than re-validated per derivation.
 */
const RESERVED_IDENTITY_SEPARATORS = ["|", "/"] as const;

function withoutReservedSeparators(schema: z.ZodString, fieldName: string): z.ZodString {
  return schema.refine((value) => !RESERVED_IDENTITY_SEPARATORS.some((separator) => value.includes(separator)), {
    message: `${fieldName} must not contain "|" or "/" — both are reserved as canonical-id separators`,
  });
}

const chainIdSchema = withoutReservedSeparators(
  z.string().min(1, "chainId must be a non-empty string"),
  "chainId",
);
const withdrawalNetworkSchema = withoutReservedSeparators(
  z.string().min(1, "withdrawalNetwork must be a non-empty string"),
  "withdrawalNetwork",
);

const contractAssetIdentitySchema = z.object({
  kind: z.literal("contract"),
  chainId: chainIdSchema,
  contractAddress: withoutReservedSeparators(
    z.string().min(1, "contractAddress must be a non-empty string"),
    "contractAddress",
  ),
  withdrawalNetwork: withdrawalNetworkSchema,
});

const mintAssetIdentitySchema = z.object({
  kind: z.literal("mint"),
  chainId: chainIdSchema,
  mintAddress: withoutReservedSeparators(z.string().min(1, "mintAddress must be a non-empty string"), "mintAddress"),
  withdrawalNetwork: withdrawalNetworkSchema,
});

const nativeAssetIdentitySchema = z.object({
  kind: z.literal("native"),
  chainId: chainIdSchema,
  nativeDenomination: withoutReservedSeparators(
    z.string().min(1, "nativeDenomination must be a non-empty string"),
    "nativeDenomination",
  ),
  withdrawalNetwork: withdrawalNetworkSchema,
});

export const ASSET_IDENTITY_KINDS = ["contract", "mint", "native"] as const;

/**
 * The three ways an asset may be identified on its chain — exactly one of
 * contract address, mint address, or native denomination, discriminated by
 * `kind` so "exactly one" is a type-level guarantee rather than a
 * nullability combination a refine() has to police at runtime.
 *
 * Branded as a whole (not just its component strings): the only way to
 * hold a value typed `AssetIdentity` is to have parsed it through this
 * schema, which is what actually runs the `withoutReservedSeparators`
 * refinements above. Before this brand, a caller could write a plain
 * object literal — `const bad: AssetIdentity = { kind: "contract",
 * chainId: "1", contractAddress: "a|b", withdrawalNetwork: "c" }` — that
 * type-checked without ever going through `assetIdentitySchema`, so
 * `canonicalAssetId` and `compareAssetIdentity` below had to either trust
 * an unvalidated object or re-validate on every call. Branding turns that
 * bypass into a compile-time error instead: `canonicalAssetId`'s type
 * signature (`AssetIdentity -> AssetId`, never failing) is now honestly
 * unconditional, because nothing can reach it without already having
 * satisfied every field constraint. This is the same idiom
 * `packages/contracts/src/money.ts`'s `DecimalString` already uses, kept
 * consistent here rather than adding a second, weaker pattern (re-running
 * `safeParse` inside every consumer and threading a reason-coded refusal
 * through call sites that are otherwise pure derivations) that every
 * future `@vigil/market`/`@vigil/ledger` caller would have to remember to
 * repeat correctly.
 */
export const assetIdentitySchema = z
  .discriminatedUnion("kind", [contractAssetIdentitySchema, mintAssetIdentitySchema, nativeAssetIdentitySchema])
  .brand<"AssetIdentity">();

export type AssetIdentity = z.infer<typeof assetIdentitySchema>;

/**
 * A canonical asset id has the exact shape
 * "chainId|kind|value|withdrawalNetwork": three "|" delimiters, four
 * non-empty segments, and `kind` drawn from the `ASSET_IDENTITY_KINDS`
 * registry (derived from the registry, not hand-copied, so this pattern
 * cannot drift from it). Every component field already excludes "|" and
 * "/" (`withoutReservedSeparators` above), so this pattern excludes "/"
 * from every segment too: a value `canonicalAssetId` actually produces
 * can never contain one, and rejecting a hand-typed string that does is
 * exactly what lets `@vigil/market`'s `instrumentIdSchema` tell two
 * asset-id halves apart by splitting an instrument id on its own "/".
 */
const CANONICAL_ASSET_ID_PATTERN = new RegExp(String.raw`^[^|/]+\|(?:${ASSET_IDENTITY_KINDS.join("|")})\|[^|/]+\|[^|/]+$`);

/**
 * The canonical, opaque identifier derived from an `AssetIdentity`. Two
 * identities that resolve to the same `AssetId` are the same asset; two
 * that do not are different assets regardless of any shared display
 * ticker. Branded so a caller cannot construct one except by deriving it
 * with `canonicalAssetId` — and the shape check above means an ad hoc,
 * ticker-only, or otherwise hand-typed string (e.g. "BTC-USD") that never
 * went through derivation at all is rejected too, not just an empty one.
 */
export const assetIdSchema = z
  .string()
  .min(1)
  .regex(CANONICAL_ASSET_ID_PATTERN, {
    message:
      "must match the canonical asset-id shape: chainId, kind (one of the ASSET_IDENTITY_KINDS registry members), value, and withdrawalNetwork, joined by the pipe character",
  })
  .brand<"AssetId">();

export type AssetId = z.infer<typeof assetIdSchema>;

function identityValue(identity: AssetIdentity): string {
  switch (identity.kind) {
    case "contract":
      return identity.contractAddress;
    case "mint":
      return identity.mintAddress;
    case "native":
      return identity.nativeDenomination;
  }
}

/**
 * Derives the canonical `AssetId` for an identity. Deterministic and pure:
 * the same identity always derives the same id, and two identities that
 * differ in chain, kind, contract/mint/native value, or withdrawal network
 * derive different ids.
 */
export function canonicalAssetId(identity: AssetIdentity): AssetId {
  const raw = [identity.chainId, identity.kind, identityValue(identity), identity.withdrawalNetwork].join("|");
  return assetIdSchema.parse(raw);
}

/**
 * The result of comparing a declared identity (what a candidate, position,
 * or approved intent names) against a resolved identity (what was actually
 * observed on-chain or at a venue). Never thrown — a mismatch is data, per
 * docs/resilience.md §4.
 */
export type AssetIdentityComparison =
  | { readonly matches: true }
  | { readonly matches: false; readonly reasonCode: ReasonCode; readonly detail: string };

/**
 * Compares a declared `AssetIdentity` against a resolved one and reports a
 * reason-coded mismatch rather than throwing (docs/resilience.md §4, §5).
 *
 * Reason-code choice:
 * - A chain mismatch uses `WRONG_CHAIN` — docs/policy.md's own description
 *   ("the resolved asset or route does not match the intent's declared
 *   chain identity") is a direct fit.
 * - Every other mismatch — a different `kind` (e.g. a mint where a
 *   contract was declared), a different contract/mint/native value on the
 *   same chain, or a different withdrawal network for what is otherwise
 *   the same token — uses `UNAPPROVED_ASSET`. docs/policy.md describes it
 *   as "the resolved contract/mint is not on the approved asset list for
 *   its declared identity," which is exactly this shape: the declared
 *   identity (what a same-ticker lookup expected) names one contract/mint
 *   or network, and what actually resolved is a different one. The
 *   registry defines no separate code for a withdrawal-network-only
 *   mismatch, so it is folded into the same "resolved identity does not
 *   match declared identity" outcome rather than inventing a new code.
 */
export function compareAssetIdentity(declared: AssetIdentity, resolved: AssetIdentity): AssetIdentityComparison {
  if (declared.chainId !== resolved.chainId) {
    return {
      matches: false,
      reasonCode: "WRONG_CHAIN",
      detail: `declared chain "${declared.chainId}" does not match resolved chain "${resolved.chainId}"`,
    };
  }

  if (
    declared.kind !== resolved.kind ||
    identityValue(declared) !== identityValue(resolved) ||
    declared.withdrawalNetwork !== resolved.withdrawalNetwork
  ) {
    return {
      matches: false,
      reasonCode: "UNAPPROVED_ASSET",
      detail:
        `resolved ${resolved.kind} identity "${identityValue(resolved)}" on withdrawal network ` +
        `"${resolved.withdrawalNetwork}" does not match the declared ${declared.kind} identity ` +
        `"${identityValue(declared)}" on withdrawal network "${declared.withdrawalNetwork}" ` +
        `(both on chain "${declared.chainId}")`,
    };
  }

  return { matches: true };
}

/**
 * Display metadata for an asset — a ticker/symbol and the canonical id it
 * resolves to. Deliberately separate from `AssetIdentity`: a symbol is
 * never identity (docs/capabilities.md "On-chain identity rules"), so it
 * has no place inside the identity schema itself. This shape exists so a
 * "same ticker, different identity" scenario can be expressed and tested
 * literally, the way a real symbol-keyed lookup table would encounter it.
 */
export const assetMetadataSchema = z.object({
  assetId: assetIdSchema,
  symbol: z.string().min(1, "symbol must be a non-empty string"),
});

export type AssetMetadata = z.infer<typeof assetMetadataSchema>;
