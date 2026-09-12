import { z } from "zod";
import { assetIdentitySchema, assetIdSchema, canonicalAssetId } from "@vigil/contracts";

/**
 * instrument-identity.ts — a tradable instrument/route built on top of
 * `@vigil/contracts`' asset identity (docs/architecture.md "Market/quote
 * engine": "Owns identity mapping, instruments/pools, order books or
 * executable quotes, trades, bars, status, metadata, freshness, and
 * health").
 *
 * BOOT-03 builds exactly one synthetic instrument/route (this issue's
 * settled scope: "One synthetic instrument/route only; no second
 * instrument") — this shape supports more without a redesign, but nothing
 * in this package constructs a second one.
 */
export const instrumentIdentitySchema = z.object({
  baseAsset: assetIdentitySchema,
  quoteAsset: assetIdentitySchema,
});

export type InstrumentIdentity = z.infer<typeof instrumentIdentitySchema>;

/**
 * The canonical, opaque identifier for an instrument, derived from its
 * base and quote asset identities. Branded so a caller cannot construct
 * one except by deriving it with `canonicalInstrumentId` — and, beyond
 * mere non-emptiness, this schema requires the string to actually split
 * into two halves on "/" that each independently satisfy
 * `@vigil/contracts`' `assetIdSchema` canonical shape. Without this, an
 * ad hoc or ticker-only string ("instrument-a", "BTC-USD") would brand
 * successfully and a quote carrying it could be marked executable
 * without ever having a chain-aware base/quote identity behind it. This
 * does not recover the exact original `AssetIdentity` fields (a
 * withdrawal network is still just an opaque string within its half),
 * only that each half has the shape only `canonicalAssetId` produces.
 */
export const instrumentIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const separatorIndex = value.indexOf("/");
      if (separatorIndex === -1) {
        return false;
      }
      const baseAssetId = value.slice(0, separatorIndex);
      const quoteAssetId = value.slice(separatorIndex + 1);
      return assetIdSchema.safeParse(baseAssetId).success && assetIdSchema.safeParse(quoteAssetId).success;
    },
    {
      message:
        "must be two canonical asset ids joined by a slash (baseAssetId/quoteAssetId), each matching the canonical asset-id shape from @vigil/contracts",
    },
  )
  .brand<"InstrumentId">();

export type InstrumentId = z.infer<typeof instrumentIdSchema>;

/**
 * Derives the canonical `InstrumentId` for an instrument. Deterministic:
 * the same base/quote pair always derives the same id, and swapping base
 * and quote (a genuinely different instrument — the inverse route) derives
 * a different one.
 */
export function canonicalInstrumentId(instrument: InstrumentIdentity): InstrumentId {
  const raw = `${canonicalAssetId(instrument.baseAsset)}/${canonicalAssetId(instrument.quoteAsset)}`;
  return instrumentIdSchema.parse(raw);
}
