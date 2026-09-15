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
 * ## Two classes of helper, and why the split is load-bearing
 *
 * An earlier version of this comment claimed that every value reaching this
 * file "has already been parsed by `decimalStringSchema`". **That is false,
 * and the belief cost a production defect** (CI on PR #41): in Zod 4 a
 * `.refine()` callback is NOT downstream of the base parse. Zod 4 aggregates
 * issues instead of short-circuiting, so a refine runs even when the string
 * check it is attached to already failed — an object-level refine runs even
 * when one of its own fields failed — and a `throw` from inside a refine
 * escapes `safeParse` entirely rather than becoming an issue. A refine
 * callback is therefore itself a trust boundary, and must tolerate any
 * string, including one that just failed validation.
 *
 * So the helpers below are split, and the split is the contract:
 *
 * **Trust-boundary-safe — total over `string`, never throw.** Safe to call
 * from a zod `.refine()`, and typed `string` rather than `DecimalString` to
 * say so in the signature:
 * `isDecomposable`, `isNegative`, `isZero`, `isPositive`, `scaleOf`.
 * Each answers safely for a value it cannot decompose: the three predicates
 * return `false` (an undecomposable value is not negative, not zero, and not
 * positive — it is not a number at all), and `scaleOf` returns `NaN`, so a
 * comparison like `scaleOf(v) <= MAX` is `false` and the refine simply
 * fails.
 *
 * **Arithmetic — require a decomposable value and throw otherwise.**
 * `decompose`, `toScaled`, `fromScaled`, `compareDecimal`, `addDecimal`,
 * `subtractDecimal`, `multiplyDecimal`, `minDecimal`, `divideFloor`,
 * `floorToScale`. These run only after a successful parse, from inside this
 * package's own logic. They stay strict deliberately: on the money path a
 * genuine programmer error must fail loudly, not produce a quietly wrong
 * number — the posture `packages/strategies/src/scaled-decimal.ts` and
 * `packages/market/src/prng.ts` also take.
 *
 * **If you add a `.refine()` that needs an arithmetic helper** (the
 * cross-field ordering check in `eligibility.ts`'s `entryZoneSchema` is the
 * one that does), gate it on `isDecomposable` for every value it touches
 * first. `compareDecimal` has no safe answer to return — there is no
 * "unknown" member of `-1 | 0 | 1`, and widening it to `null` would be worse
 * than throwing, since `null <= 0` is `true` in JavaScript.
 */

const DECIMAL_SHAPE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Deliberately not a `/g` regex: a stateful `lastIndex` would make `test` alternate between true and false on repeated calls. */
const NON_ZERO_DIGIT = /[1-9]/;

type DecimalParts = {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
};

/**
 * The total core: `null` for anything this helper cannot split into
 * whole/fraction parts. Every trust-boundary-safe helper above is built on
 * this, so none of them can throw on a value a refine hands them.
 */
function tryDecompose(value: string): DecimalParts | null {
  const match = DECIMAL_SHAPE.exec(value);
  if (match === null) {
    return null;
  }
  const [, sign, whole, fraction] = match;
  return { negative: sign === "-", whole: whole ?? "0", fraction: fraction ?? "" };
}

/**
 * The strict core used by every arithmetic helper. Throws on an
 * undecomposable value, which on those paths means a caller inside this
 * package reached arithmetic with something that never parsed — a
 * programmer error that must not quietly produce a number.
 */
function decompose(value: DecimalString): DecimalParts {
  const parts = tryDecompose(value);
  if (parts === null) {
    throw new Error(`scaled-decimal: "${value}" is not a shape this helper can decompose into whole/fraction parts`);
  }
  return parts;
}

/**
 * Trust-boundary-safe shape gate. Answers whether the arithmetic helpers
 * can accept `value` at all, without throwing on the answer — the check a
 * `.refine()` must make before calling anything in the arithmetic half.
 *
 * Deliberately looser than `@vigil/contracts`' `DECIMAL_STRING_PATTERN`: it
 * reports only what this module guarantees (that `decompose` will not
 * throw), not that the value is a canonical wire-form decimal. The wire
 * form is the base schema's job.
 */
export function isDecomposable(value: string): boolean {
  return tryDecompose(value) !== null;
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
export function scaleOf(value: string): number {
  // Trust-boundary-safe: `NaN` for an undecomposable value, so a refine's
  // `scaleOf(v) <= MAX` is false and the refine fails instead of throwing.
  // On the arithmetic path a NaN scale reaches `assertScale` and throws
  // loudly, which is the correct outcome there.
  const parts = tryDecompose(value);
  return parts === null ? Number.NaN : parts.fraction.length;
}

/** Trust-boundary-safe. True when `value` is strictly less than zero; false for anything undecomposable. */
export function isNegative(value: string): boolean {
  const parts = tryDecompose(value);
  return parts !== null && parts.negative;
}

/** Trust-boundary-safe. True when `value` is exactly zero, in any spelling (`"0"`, `"0.0"`, `"0.000"`); false for anything undecomposable. */
export function isZero(value: string): boolean {
  const parts = tryDecompose(value);
  return parts !== null && !NON_ZERO_DIGIT.test(parts.whole) && !NON_ZERO_DIGIT.test(parts.fraction);
}

/**
 * Trust-boundary-safe. True when `value` is greater than zero; false for
 * anything undecomposable.
 *
 * Derived from the parts directly rather than as `!isNegative && !isZero`.
 * That composition looks equivalent and is not: now that both predicates
 * answer `false` for an undecomposable value, negating them both would make
 * `isPositive("1e-3")` return `true` — reporting garbage as a positive
 * amount, which is exactly the fail-open this whole split exists to close.
 */
export function isPositive(value: string): boolean {
  const parts = tryDecompose(value);
  return parts !== null && !parts.negative && (NON_ZERO_DIGIT.test(parts.whole) || NON_ZERO_DIGIT.test(parts.fraction));
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
