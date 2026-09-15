import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

/**
 * venue-math.ts — the exact-integer arithmetic primitives the simulated
 * venue computes prices, notionals, and fees with. Every value is walked
 * as a `bigint` count of units at a declared decimal scale and rendered
 * back through `decimalStringSchema`; nothing in this package ever turns a
 * price, quantity, or fee into a JavaScript number. `Number()`,
 * `parseFloat`, `parseInt`, `toFixed` and unary `+` are not applied to
 * money anywhere in `@vigil/adapter-paper`.
 *
 * This duplicates a technique — not a file — that
 * `packages/ledger/src/base-units.ts` and
 * `packages/strategies/src/scaled-decimal.ts` also implement locally.
 * `adapter-paper` may import only `@vigil/contracts` and `@vigil/market`
 * (`docs/architecture.md` "Layer graph and import rules"), so it cannot
 * reuse either of those; issue #20 owns unifying the copies once a shared
 * home exists. The three differ in posture on purpose, and this one is the
 * strictest:
 *
 * - `unitsOf` returns `null` rather than throwing when a value carries
 *   more precision than the venue's scale can hold. That case is real
 *   external input here — a caller hands this adapter an intent quantity
 *   and a quote it did not produce — so it becomes a reason-coded refusal
 *   at the boundary (`docs/resilience.md` §4), not an exception.
 * - `renderUnits` renders at a FIXED scale ("0.00", not "0"). A venue
 *   reports money at its own precision, and a fixed rendering makes the
 *   wire value of a fee or a notional a stable literal a test can pin.
 *
 * A `scale` argument is always an internal call-site constant taken from
 * the exchange's own configuration, never untrusted input, so a negative
 * or non-integer scale throws: that is a programmer error, which is the
 * one thing `docs/resilience.md` §4 still reserves an exception for.
 */

const DECIMAL_PARTS = /^(-?)(\d+)(?:\.(\d+))?$/;

type DecimalParts = {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
};

function assertScale(scale: number, caller: string): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) {
    throw new Error(`${caller}: scale must be an integer in [0, 30], got ${String(scale)}`);
  }
}

function partsOf(value: string, caller: string): DecimalParts {
  const match = DECIMAL_PARTS.exec(value);
  if (match === null) {
    // Unreachable for anything that actually parsed as a `DecimalString`;
    // only a caller that bypassed the brand with a cast lands here.
    throw new Error(`${caller}: "${value}" is not a decimal string this helper can decompose`);
  }
  const [, sign, whole, fraction] = match;
  return { negative: sign === "-", whole: whole ?? "0", fraction: fraction ?? "" };
}

/** How many fractional digits `value` carries as written: `"7"` is 0, `"7.50"` is 2. */
export function fractionalDigits(value: DecimalString): number {
  return partsOf(value, "fractionalDigits").fraction.length;
}

/**
 * Converts `value` into an exact integer count of units at `scale`, or
 * `null` when `value` carries more fractional digits than `scale` can hold
 * exactly. `null` is never "zero" and never "close enough" — the caller
 * turns it into a refusal.
 */
export function unitsOf(value: DecimalString, scale: number): bigint | null {
  assertScale(scale, "unitsOf");
  const { negative, whole, fraction } = partsOf(value, "unitsOf");
  if (fraction.length > scale) {
    return null;
  }
  const magnitude = BigInt(whole + fraction.padEnd(scale, "0"));
  return negative ? -magnitude : magnitude;
}

/**
 * The inverse of `unitsOf`, at a fixed scale: `renderUnits(1234n, 2)` is
 * `"12.34"` and `renderUnits(0n, 2)` is `"0.00"`. A bigint has no negative
 * zero, so the sign is emitted only for a strictly negative magnitude and
 * the `-0` spelling `decimalStringSchema` rejects can never be produced.
 */
export function renderUnits(units: bigint, scale: number): DecimalString {
  assertScale(scale, "renderUnits");
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const boundary = digits.length - scale;
  const magnitude = scale === 0 ? digits : `${digits.slice(0, boundary)}.${digits.slice(boundary)}`;
  return decimalStringSchema.parse(negative ? `-${magnitude}` : magnitude);
}

/**
 * Orders two decimal strings by value rather than by spelling, at whatever
 * scale holds both of them exactly — `"5"` and `"5.00"` compare equal.
 */
export function compareDecimals(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const scale = Math.max(fractionalDigits(left), fractionalDigits(right));
  const leftUnits = unitsOf(left, scale);
  const rightUnits = unitsOf(right, scale);
  if (leftUnits === null || rightUnits === null) {
    throw new Error("compareDecimals: a scale wide enough for both operands could not hold one of them");
  }
  if (leftUnits < rightUnits) {
    return -1;
  }
  if (leftUnits > rightUnits) {
    return 1;
  }
  return 0;
}

/** Rounding direction for a division that does not divide evenly. */
export type Rounding = "UP" | "DOWN";

/**
 * `left * right / divisor` on non-negative magnitudes, rounded in the
 * direction the caller names. The multiplication happens before the
 * division so no intermediate precision is lost, and the direction is
 * always chosen by the call site to be the one that cannot favour vigil:
 * a buyer's notional and every fee round UP, a seller's proceeds round
 * DOWN. Negative operands are rejected because every quantity, price, and
 * fee this module multiplies is a magnitude — a sign belongs to the
 * direction of the cash flow, which is applied afterwards.
 */
export function mulDiv(left: bigint, right: bigint, divisor: bigint, rounding: Rounding): bigint {
  if (divisor <= 0n) {
    throw new Error(`mulDiv: divisor must be positive, got ${String(divisor)}`);
  }
  if (left < 0n || right < 0n) {
    throw new Error(`mulDiv: operands must be non-negative magnitudes, got ${String(left)} and ${String(right)}`);
  }
  const product = left * right;
  if (rounding === "DOWN") {
    return product / divisor;
  }
  return (product + divisor - 1n) / divisor;
}

/** `10 ** scale` as a bigint, for converting between two declared scales. */
export function scaleFactor(scale: number): bigint {
  assertScale(scale, "scaleFactor");
  return 10n ** BigInt(scale);
}

/**
 * FNV-1a over the seed material, kept entirely on 32-bit integers
 * (`Math.imul`, `>>> 0`). This is the package's only source of
 * pseudo-randomness and it never touches money: it produces the weights
 * `splitUnits` distributes a quantity by, and the quantity itself stays a
 * bigint throughout. A hash rather than the mulberry32 stream
 * `packages/market/src/prng.ts` uses, because this adapter needs a fill
 * schedule that depends only on (seed, client order id) — reproducible per
 * order, independent of how many other orders the exchange handled first —
 * rather than on a position in one shared draw sequence.
 */
function fnv1a32(material: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Splits `totalUnits` into exactly `stepCount` strictly-positive parts that
 * sum to `totalUnits` exactly, deterministically from `seedMaterial`. Every
 * part starts at one unit and the surplus is distributed by hash-derived
 * weights, with the last part taking the remainder — so the sum is exact by
 * construction rather than by a rounding that happens to work out, and no
 * part is ever a zero-quantity "fill".
 *
 * When `totalUnits` is smaller than `stepCount` there is no way to give
 * every step a positive quantity, so the split collapses to a single part
 * carrying the whole amount rather than pretending to more fills than the
 * quantity can express.
 */
export function splitUnits(totalUnits: bigint, stepCount: number, seedMaterial: string): readonly bigint[] {
  if (!Number.isInteger(stepCount) || stepCount < 1) {
    throw new Error(`splitUnits: stepCount must be a positive integer, got ${String(stepCount)}`);
  }
  if (totalUnits <= 0n) {
    throw new Error(`splitUnits: totalUnits must be positive, got ${String(totalUnits)}`);
  }
  if (totalUnits < BigInt(stepCount)) {
    return [totalUnits];
  }

  const weights: bigint[] = [];
  let totalWeight = 0n;
  for (let step = 0; step < stepCount; step += 1) {
    // `% 97 + 1` keeps every weight in [1, 97]: strictly positive, so no
    // step can be weighted out of existence, and prime-bounded so a run of
    // similar seed material does not collapse onto a single value.
    const weight = BigInt((fnv1a32(`${seedMaterial}#${String(step)}`) % 97) + 1);
    weights.push(weight);
    totalWeight += weight;
  }

  const surplus = totalUnits - BigInt(stepCount);
  const parts: bigint[] = [];
  let distributed = 0n;
  for (let step = 0; step < stepCount - 1; step += 1) {
    const weight = weights[step] ?? 1n;
    const share = (surplus * weight) / totalWeight;
    distributed += share;
    parts.push(1n + share);
  }
  parts.push(1n + (surplus - distributed));
  return parts;
}
