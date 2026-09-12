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

/**
 * The largest magnitude a base-unit amount may carry, in either direction:
 * 78 digits, which is what `packages/db` stores every base-unit column as
 * (`numeric(78, 0)`, room for a 256-bit integer).
 *
 * Bounding the scale is not enough on its own. An amount whose digits exceed
 * the column reaches Postgres as a `numeric field overflow`, which is a
 * driver error raised in the middle of a write rather than a diagnostic the
 * caller can act on — so the range is checked here, where the value is still
 * a value and not yet a row.
 */
export const MAX_BASE_UNIT_MAGNITUDE = 10n ** 78n - 1n;

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

/** The refused branch both result unions share. */
type RangeRefusal = { readonly outcome: "refused"; readonly refusal: LedgerRefusal };

function outOfRange(magnitude: bigint): RangeRefusal {
  return {
    outcome: "refused",
    refusal: ledgerRefusal(
      "AMOUNT_OUT_OF_RANGE",
      `amount of ${String(magnitude.toString().length)} digits exceeds the 78-digit base-unit range`,
    ),
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
  if (magnitude > MAX_BASE_UNIT_MAGNITUDE) {
    return outOfRange(magnitude);
  }
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
  const magnitude = negative ? -base : base;
  if (magnitude > MAX_BASE_UNIT_MAGNITUDE) {
    return outOfRange(magnitude);
  }
  const digits = magnitude.toString();
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
