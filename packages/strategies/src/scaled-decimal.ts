import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

/**
 * scaled-decimal.ts — a minimal bigint-on-scaled-integers helper for this
 * package's own entry-zone and tranche arithmetic. `packages/strategies`
 * cannot import `@vigil/ledger` (`docs/architecture.md` "Layer graph and
 * import rules": `strategies` depends only on `contracts` and `market`),
 * so this is a small, independent seam rather than a copy of
 * `packages/ledger/src/base-units.ts`'s `toBaseUnits`/`fromBaseUnits` —
 * issue #20 owns unifying the two later. Every price and quantity this
 * package computes is walked as a `bigint` count of units at some decimal
 * scale and rendered back through `decimalStringSchema`; nothing here
 * ever becomes a JavaScript number (`parseFloat`, `Number()`, and
 * `toFixed()` are all banned on money — see this package's README).
 *
 * Unlike the ledger's base-unit conversion, this helper has no
 * external-input trust boundary of its own: every `DecimalString` it
 * receives has already been parsed by `decimalStringSchema` (a quote
 * field, or a `StrategyConfig` value the generator's own config guard
 * checked). So there is no reason-coded refusal type here — a value that
 * cannot be decomposed, or a scale that cannot hold it exactly, is a
 * programmer error in the caller and throws, the same posture
 * `packages/market/src/prng.ts`'s `unitsToDecimalString` takes for the
 * same reason.
 */

const DECIMAL_SHAPE = /^(-)?(\d+)(?:\.(\d+))?$/;

function decompose(value: DecimalString): { readonly negative: boolean; readonly whole: string; readonly fraction: string } {
  const match = DECIMAL_SHAPE.exec(value);
  if (match === null) {
    // Unreachable for any value that actually passed decimalStringSchema —
    // this only fires if a caller bypassed the brand with a cast.
    throw new Error(`scaled-decimal: "${value}" is not a shape this helper can decompose into whole/fraction parts`);
  }
  const [, sign, whole, fraction] = match;
  return { negative: sign === "-", whole: whole ?? "0", fraction: fraction ?? "" };
}

/**
 * The number of fractional digits `value` carries as written — `"250"` is
 * 0, `"250.0"` is 1, `"250.10"` is 2. Used to pick a scale that loses no
 * precision without the caller having to track it separately.
 */
export function scaleOf(value: DecimalString): number {
  return decompose(value).fraction.length;
}

/**
 * Converts `value` to an exact integer count of units at `scale`. Refuses
 * (by throwing — see the module comment) only when `value` carries more
 * fractional digits than `scale` can hold, which would otherwise silently
 * drop precision.
 */
export function toScaled(value: DecimalString, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`toScaled: scale must be a non-negative integer, got ${String(scale)}`);
  }
  const { negative, whole, fraction } = decompose(value);
  if (fraction.length > scale) {
    throw new Error(`toScaled: "${value}" carries ${String(fraction.length)} fractional digits; scale ${String(scale)} cannot hold it exactly`);
  }
  const magnitude = BigInt(whole + fraction.padEnd(scale, "0"));
  return negative ? -magnitude : magnitude;
}

/**
 * The inverse of `toScaled`: renders an exact integer count of units at
 * `scale` back to the canonical `DecimalString` spelling (no trailing
 * fractional zeros, no negative zero), re-parsed through
 * `decimalStringSchema` before it is returned.
 */
export function fromScaled(units: bigint, scale: number): DecimalString {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`fromScaled: scale must be a non-negative integer, got ${String(scale)}`);
  }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const splitAt = digits.length - scale;
  const whole = digits.slice(0, splitAt);
  const fraction = scale === 0 ? "" : digits.slice(splitAt).replace(/0+$/, "");
  const unsigned = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return decimalStringSchema.parse(negative ? `-${unsigned}` : unsigned);
}

/** The common scale two decimal strings need to compare or combine without losing either one's precision. */
function commonScale(a: DecimalString, b: DecimalString): number {
  return Math.max(scaleOf(a), scaleOf(b));
}

/**
 * Compares two decimal strings by value, not by spelling — `"250.10"` and
 * `"250.1"` compare equal even though they are different strings.
 */
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const scale = commonScale(a, b);
  const left = toScaled(a, scale);
  const right = toScaled(b, scale);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function addDecimal(a: DecimalString, b: DecimalString): DecimalString {
  const scale = commonScale(a, b);
  return fromScaled(toScaled(a, scale) + toScaled(b, scale), scale);
}

export function subtractDecimal(a: DecimalString, b: DecimalString): DecimalString {
  const scale = commonScale(a, b);
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale);
}
