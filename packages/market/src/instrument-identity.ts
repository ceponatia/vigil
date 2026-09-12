import { z } from "zod";
import { assetIdentitySchema, canonicalAssetId } from "@vigil/contracts";

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
 * one except by deriving it with `canonicalInstrumentId`.
 */
export const instrumentIdSchema = z.string().min(1).brand<"InstrumentId">();

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
