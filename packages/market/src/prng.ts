import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

/**
 * prng.ts — the deterministic, seeded integer PRNG behind
 * `synthetic-feed.ts`, plus the pure integer-to-decimal-string renderer
 * used to turn a generated integer base-unit quantity into money's wire
 * type. Neither function performs IO or reads a clock.
 *
 * `@vigil/contracts/money.ts` deliberately does not own a decimal-string
 * renderer yet ("which library represents [money] is a decision for the
 * first slice that implements this package, not a dependency added ahead
 * of that decision" — packages/contracts/README.md); `unitsToDecimalString`
 * below is scoped to this package's own synthetic-fixture need, not a
 * general-purpose money formatter for the whole workspace.
 */

/**
 * mulberry32 — a 32-bit integer PRNG (Tommy Ettinger, public domain). This
 * variant returns the raw unsigned 32-bit integer output, never the
 * `/ 4294967296` float reduction the algorithm is usually written with:
 * every operation inside stays on 32-bit integers (`|0`, `>>>`,
 * `Math.imul`), and the caller decides how to turn an integer draw into a
 * bounded value (see `randomBigIntInRange`), so no part of this module can
 * leak an IEEE-754 float into a price or quantity.
 */
export function createMulberry32(seed: number): () => number {
  let state = seed | 0;

  return function nextUint32(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * Draws an integer uniformly (modulo the usual small bias from reducing a
 * 32-bit draw, acceptable for a synthetic test fixture and never used for
 * anything security-sensitive) from `[min, max]` inclusive, both bigint.
 * `BigInt(nextUint32())` is an exact, lossless conversion — `nextUint32()`
 * always returns a safe integer in `[0, 2^32 - 1]` — so no precision is
 * lost converting the PRNG's number output into the bigint domain money
 * arithmetic stays in.
 */
export function randomBigIntInRange(nextUint32: () => number, min: bigint, max: bigint): bigint {
  if (max < min) {
    // A programmer error in caller-supplied bounds, not schema-legal
    // external input — this function has no untrusted-input boundary of
    // its own (docs/resilience.md §4 reserves throwing for exactly this
    // case).
    throw new Error(`randomBigIntInRange: max (${String(max)}) is less than min (${String(min)})`);
  }

  const span = max - min + 1n;
  const draw = BigInt(nextUint32());
  return min + (draw % span);
}

/**
 * Renders an exact integer number of base units, at a fixed decimal
 * `scale`, as a `DecimalString` — using only `BigInt#toString()` and plain
 * string slicing. No `Number()`, no `parseFloat`, no `toFixed`: the value
 * never becomes a JavaScript number at any point in this function.
 */
export function unitsToDecimalString(units: bigint, scale: number): DecimalString {
  if (!Number.isInteger(scale) || scale < 0) {
    // Same reasoning as above: `scale` is an internal call-site constant,
    // never external input, so a thrown error here is a programmer-error
    // guard, not a violation of "never throw on schema-legal input".
    throw new Error(`unitsToDecimalString: scale must be a non-negative integer, got ${String(scale)}`);
  }

  const negative = units < 0n;
  const absoluteUnits = negative ? -units : units;
  const digits = absoluteUnits.toString();
  const padded = digits.padStart(scale + 1, "0");
  const splitAt = padded.length - scale;
  const integerPart = scale === 0 ? padded : padded.slice(0, splitAt);
  const fractionPart = scale === 0 ? "" : padded.slice(splitAt);

  // Negative zero (`-0`, `-0.00`, …) is not a valid DecimalString
  // (packages/contracts/src/money.ts) — suppress the sign whenever the
  // magnitude is exactly zero.
  const sign = negative && absoluteUnits !== 0n ? "-" : "";
  const raw = fractionPart.length > 0 ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;

  return decimalStringSchema.parse(raw);
}
