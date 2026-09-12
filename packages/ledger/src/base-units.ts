import { decimalStringSchema, type DecimalString } from "@vigil/contracts";
import { z } from "zod";

import { ledgerRefusal, type LedgerRefusal } from "./diagnostics";

/**
 * Money in this package is an exact integer count of an asset's smallest
 * unit (`bigint`) beside the scale that says how many decimal places that
 * unit represents — never a float, and never a decimal-arithmetic library
 * (`packages/contracts/README.md` leaves that choice to the first
 * implementing slice; `bigint` needs no dependency at all).
 *
 * `DecimalString` is the wire form; base units are the internal form. This
 * module owns the only conversion between them, so no other module is ever
 * tempted to reach for `parseFloat`, `Number()`, or `toFixed()`.
 *
 * Scale is bounded at 36: an 18-decimal token squared still fits, no real
 * asset exceeds it, and 10^36 base units stay inside the `numeric(78, 0)`
 * columns `packages/db` stores them in.
 */
export const MIN_ASSET_SCALE = 0;
export const MAX_ASSET_SCALE = 36;

export const assetScaleSchema = z
  .number()
  .int()
  .min(MIN_ASSET_SCALE)
  .max(MAX_ASSET_SCALE);

export type BaseUnitResult =
  | { readonly outcome: "ok"; readonly base: bigint }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal };

export type DecimalResult =
  | { readonly outcome: "ok"; readonly amount: DecimalString }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal };

function splitDecimal(amount: string): {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
} {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const dot = unsigned.indexOf(".");
  return {
    negative,
    whole: dot === -1 ? unsigned : unsigned.slice(0, dot),
    fraction: dot === -1 ? "" : unsigned.slice(dot + 1),
  };
}

/**
 * Convert a validated decimal string into base units at `scale`.
 *
 * Refuses rather than rounds when the amount carries more precision than the
 * scale can hold: silently dropping `0.0000005` turns a rejected order into a
 * free one, and silently rounding it up spends money nobody authorized.
 */
export function toBaseUnits(amount: DecimalString, scale: number): BaseUnitResult {
  if (!assetScaleSchema.safeParse(scale).success) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal("SCALE_OUT_OF_RANGE", `scale ${String(scale)} is outside 0..${String(MAX_ASSET_SCALE)}`),
    };
  }

  const { negative, whole, fraction } = splitDecimal(amount);

  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal(
        "UNREPRESENTABLE_PRECISION",
        `amount carries ${String(fraction.length)} decimal places; scale ${String(scale)} holds ${String(scale)}`,
      ),
    };
  }

  const scaled = fraction.length >= scale ? fraction.slice(0, scale) : fraction.padEnd(scale, "0");
  const magnitude = BigInt(`${whole}${scaled}`);
  return { outcome: "ok", base: negative ? -magnitude : magnitude };
}

/**
 * Render base units back to the canonical decimal string: no trailing
 * fractional zeros, no negative zero, no exponent — the exact spellings
 * `decimalStringSchema` accepts, so the value can cross a trust boundary
 * again without a second formatting step inventing one.
 */
export function fromBaseUnits(base: bigint, scale: number): DecimalResult {
  if (!assetScaleSchema.safeParse(scale).success) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal("SCALE_OUT_OF_RANGE", `scale ${String(scale)} is outside 0..${String(MAX_ASSET_SCALE)}`),
    };
  }

  const negative = base < 0n;
  const digits = (negative ? -base : base).toString();
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = scale === 0 ? "" : padded.slice(padded.length - scale).replace(/0+$/, "");
  const unsigned = fraction === "" ? whole : `${whole}.${fraction}`;
  const text = negative ? `-${unsigned}` : unsigned;

  const parsed = decimalStringSchema.safeParse(text);
  if (!parsed.success) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal("MALFORMED_ENTRY", `base units did not render to a decimal string: ${text}`),
    };
  }
  return { outcome: "ok", amount: parsed.data };
}
