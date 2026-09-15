import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

/**
 * scaled-decimal.ts — a minimal bigint-on-scaled-integers helper for this
 * package's own sizing and cost arithmetic. `packages/policy` cannot import
 * `@vigil/ledger` or `@vigil/strategies` (`docs/architecture.md` "Layer
 * graph and import rules": `policy` depends only on `contracts`), so this
 * is a small, independent seam rather than a copy of
 * `packages/ledger/src/base-units.ts` or
 * `packages/strategies/src/scaled-decimal.ts` — issue #20 owns unifying the
 * three later, and this slice deliberately does not attempt it.
 *
 * Every amount, price, and quantity this package computes is walked as a
 * `bigint` count of units at some decimal scale and rendered back through
 * `decimalStringSchema`; nothing here ever becomes a JavaScript number
 * (`parseFloat`, `Number()`, `parseInt`, `toFixed()` and unary `+` are all
 * banned on money — `AGENTS.md` "Financial authority and safety", and the
 * money guard in `eslint.config.mjs` enforces part of it).
 *
 * Like `packages/strategies`' copy, this helper has no external-input trust
 * boundary of its own: every `DecimalString` it receives has already been
 * parsed by `decimalStringSchema` at a public entry point in `eligibility`,
 * `sizing`, or `config`, and every sign/zero precondition below has already
 * been refused there as a reason-coded diagnostic. A violation reaching
 * this file is therefore a programmer error in a caller inside this
 * package, and throws — exactly the posture `scaled-decimal.ts` and
 * `packages/market/src/prng.ts` already document. No schema-legal *input*
 * to this package can reach a throw here.
 */

const DECIMAL_SHAPE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Deliberately not a `/g` regex: a stateful `lastIndex` would make `test` alternate between true and false on repeated calls. */
const NON_ZERO_DIGIT = /[1-9]/;

function decompose(value: DecimalString): {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
} {
  const match = DECIMAL_SHAPE.exec(value);
  if (match === null) {
    // Unreachable for any value that actually passed decimalStringSchema —
    // this only fires if a caller bypassed the brand with a cast.
    throw new Error(`scaled-decimal: "${value}" is not a shape this helper can decompose into whole/fraction parts`);
  }
  const [, sign, whole, fraction] = match;
  return { negative: sign === "-", whole: whole ?? "0", fraction: fraction ?? "" };
}

function assertScale(name: string, scale: number): void {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`${name}: scale must be a non-negative integer, got ${String(scale)}`);
  }
}

/**
 * The number of fractional digits `value` carries as written — `"250"` is
 * 0, `"250.0"` is 1, `"250.10"` is 2.
 */
export function scaleOf(value: DecimalString): number {
  return decompose(value).fraction.length;
}

/** True when `value` is strictly less than zero. `decimalStringSchema` rejects the `-0` spelling, so a leading `-` is decisive. */
export function isNegative(value: DecimalString): boolean {
  return value.startsWith("-");
}

/** True when `value` is exactly zero, in any spelling (`"0"`, `"0.0"`, `"0.000"`). */
export function isZero(value: DecimalString): boolean {
  const { whole, fraction } = decompose(value);
  return !NON_ZERO_DIGIT.test(whole) && !NON_ZERO_DIGIT.test(fraction);
}

/** True when `value` is greater than zero. */
export function isPositive(value: DecimalString): boolean {
  return !isNegative(value) && !isZero(value);
}

/**
 * Converts `value` to an exact integer count of units at `scale`. Throws
 * only when `value` carries more fractional digits than `scale` can hold,
 * which would otherwise silently drop precision.
 */
export function toScaled(value: DecimalString, scale: number): bigint {
  assertScale("toScaled", scale);
  const { negative, whole, fraction } = decompose(value);
  if (fraction.length > scale) {
    throw new Error(
      `toScaled: "${value}" carries ${String(fraction.length)} fractional digits; scale ${String(scale)} cannot hold it exactly`,
    );
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
  assertScale("fromScaled", scale);
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
 * `"250.1"` compare equal even though they are different strings. Every
 * limit comparison in this package goes through here rather than through
 * `<`/`>` on the strings themselves, where `"9"` would compare greater than
 * `"10"`.
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

/**
 * Exact product. The result's scale is the sum of the operands' scales, so
 * no digit is ever discarded and no rounding decision is taken here — a
 * notional, a proportional fee, and a cost total are all exact.
 */
export function multiplyDecimal(a: DecimalString, b: DecimalString): DecimalString {
  const scaleA = scaleOf(a);
  const scaleB = scaleOf(b);
  return fromScaled(toScaled(a, scaleA) * toScaled(b, scaleB), scaleA + scaleB);
}

/** The smaller of two decimal strings, by value. */
export function minDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return compareDecimal(a, b) <= 0 ? a : b;
}

/**
 * `floor(numerator / denominator)` at `scale`, as an exact integer count of
 * units — never a rounded-to-nearest quotient.
 *
 * Direction is the whole point: this is how a quote-currency bound (funds
 * available, exposure headroom, an adverse-loss budget) becomes a maximum
 * base-asset *quantity*, and a quotient rounded up by even one unit in the
 * last place authorizes a size the bound does not actually cover. Both
 * operands must be non-negative and the denominator strictly positive;
 * `sizing.ts` refuses a violating input as a reason-coded diagnostic before
 * calling this, so reaching the throws below is a programmer error.
 *
 * `bigint` division truncates toward zero, which equals `floor` only for a
 * non-negative quotient — hence the sign precondition rather than a sign
 * fix-up nobody would remember to test.
 */
export function divideFloor(numerator: DecimalString, denominator: DecimalString, scale: number): DecimalString {
  assertScale("divideFloor", scale);
  if (isNegative(numerator)) {
    throw new Error(`divideFloor: numerator "${numerator}" is negative; truncation toward zero would round it up`);
  }
  if (!isPositive(denominator)) {
    throw new Error(`divideFloor: denominator "${denominator}" must be strictly positive`);
  }
  const numeratorScale = scaleOf(numerator);
  const denominatorScale = scaleOf(denominator);
  const scaledNumerator = toScaled(numerator, numeratorScale) * 10n ** BigInt(denominatorScale + scale);
  const scaledDenominator = toScaled(denominator, denominatorScale) * 10n ** BigInt(numeratorScale);
  return fromScaled(scaledNumerator / scaledDenominator, scale);
}

/**
 * Rounds `value` **down** to `scale` fractional digits, the "round down to
 * the venue's supported precision" half of `docs/policy.md`'s position
 * sizing rule. A value already representable at `scale` is returned
 * unchanged, so this never invents precision either.
 *
 * Non-negative only, for the same truncation reason as `divideFloor`:
 * truncating a negative toward zero rounds it *up*, away from the
 * conservative direction the sizing rule requires.
 */
export function floorToScale(value: DecimalString, scale: number): DecimalString {
  assertScale("floorToScale", scale);
  if (isNegative(value)) {
    throw new Error(`floorToScale: "${value}" is negative; truncation toward zero would round it up`);
  }
  const currentScale = scaleOf(value);
  if (currentScale <= scale) {
    return value;
  }
  const units = toScaled(value, currentScale);
  return fromScaled(units / 10n ** BigInt(currentScale - scale), scale);
}
