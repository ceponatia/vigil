import { describe, expect, it } from "vitest";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { compareDecimals, fractionalDigits, mulDiv, renderUnits, scaleFactor, splitUnits, unitsOf } from "./venue-math";

const d = (value: string): DecimalString => decimalStringSchema.parse(value);

/**
 * The defect this file kills: money arithmetic that looks right on round
 * numbers. A fee computed with `Number(notional) * 0.0025` agrees with the
 * exact answer on almost every input and then disagrees by a cent on the
 * one that matters; a `renderUnits` that dropped trailing zeros would make
 * a venue report "0.3" for a fee of thirty cents and a persisted `numeric`
 * column would read it back differently than the venue meant it.
 */
describe("renderUnits renders at a fixed scale, with no float anywhere in the path", () => {
  it("keeps the scale's trailing zeros rather than trimming to a shortest spelling", () => {
    expect(renderUnits(1234n, 2)).toBe("12.34");
    expect(renderUnits(1230n, 2)).toBe("12.30");
    expect(renderUnits(30n, 2)).toBe("0.30");
    expect(renderUnits(0n, 2)).toBe("0.00");
  });

  it("renders at scale zero without a decimal point", () => {
    expect(renderUnits(7n, 0)).toBe("7");
    expect(renderUnits(0n, 0)).toBe("0");
  });

  it("signs a negative magnitude and can never produce negative zero", () => {
    expect(renderUnits(-5n, 2)).toBe("-0.05");
    // bigint has no -0n, so the zero branch has exactly one spelling — the
    // one decimalStringSchema accepts.
    expect(renderUnits(-0n, 2)).toBe("0.00");
  });

  it("round-trips an arbitrary magnitude through unitsOf", () => {
    const units = 987_654_321_098_765_432_109n;
    expect(unitsOf(renderUnits(units, 8), 8)).toBe(units);
  });
});

describe("unitsOf refuses precision it cannot hold instead of rounding it away", () => {
  it("returns null when the value carries more fractional digits than the scale", () => {
    expect(unitsOf(d("1.005"), 2)).toBeNull();
    expect(unitsOf(d("0.00001"), 4)).toBeNull();
  });

  it("accepts a value that fits exactly, including one written with fewer digits", () => {
    expect(unitsOf(d("1.5"), 4)).toBe(15_000n);
    expect(unitsOf(d("250"), 2)).toBe(25_000n);
    expect(unitsOf(d("-1.25"), 2)).toBe(-125n);
  });

  it("reports the digits a value actually carries", () => {
    expect(fractionalDigits(d("7"))).toBe(0);
    expect(fractionalDigits(d("7.50"))).toBe(2);
  });
});

describe("mulDiv rounds in the direction the caller names and never loses an intermediate", () => {
  it("multiplies before dividing, so a product too large for a double stays exact", () => {
    // 2^53 + 1 squared: every digit of this answer is wrong if the
    // multiplication ever passes through a JavaScript number.
    const big = 9_007_199_254_740_993n;
    expect(mulDiv(big, big, 1n, "DOWN")).toBe(big * big);
  });

  it("rounds up only when the division leaves a remainder", () => {
    expect(mulDiv(7n, 1n, 2n, "UP")).toBe(4n);
    expect(mulDiv(8n, 1n, 2n, "UP")).toBe(4n);
    expect(mulDiv(7n, 1n, 2n, "DOWN")).toBe(3n);
  });

  it("computes a 25bp fee on 500.20 as 1.26, not 1.25", () => {
    // 50020 * 25 / 10000 = 125.05 hundredths of a unit. The venue's fee
    // rounds up, so vigil is never credited with a cheaper fill than it got.
    expect(mulDiv(50_020n, 25n, 10_000n, "UP")).toBe(126n);
    expect(mulDiv(50_020n, 25n, 10_000n, "DOWN")).toBe(125n);
  });

  it("rejects a negative operand rather than guessing a rounding direction for it", () => {
    expect(() => mulDiv(-1n, 2n, 3n, "UP")).toThrow(/non-negative/);
    expect(() => mulDiv(1n, 2n, 0n, "UP")).toThrow(/positive/);
  });

  it("derives a scale factor as an exact power of ten", () => {
    expect(scaleFactor(0)).toBe(1n);
    expect(scaleFactor(4)).toBe(10_000n);
  });
});

describe("compareDecimals orders by value, not by spelling", () => {
  it("treats two spellings of one amount as equal", () => {
    expect(compareDecimals(d("5"), d("5.00"))).toBe(0);
    expect(compareDecimals(d("0"), d("0.000"))).toBe(0);
  });

  it("orders across differing scales and signs", () => {
    expect(compareDecimals(d("501.46"), d("501.45"))).toBe(1);
    expect(compareDecimals(d("-1.5"), d("1.5"))).toBe(-1);
  });
});

describe("splitUnits is deterministic and always sums to exactly the whole", () => {
  const total = 20_000n;

  it("produces the same split for the same seed material, every time", () => {
    expect(splitUnits(total, 3, "seed:idem-0001")).toEqual(splitUnits(total, 3, "seed:idem-0001"));
  });

  it("sums to the total exactly, for every step count that fits", () => {
    for (let stepCount = 1; stepCount <= 12; stepCount += 1) {
      const parts = splitUnits(total, stepCount, `seed:order-${String(stepCount)}`);
      expect(parts).toHaveLength(stepCount);
      expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(total);
      expect(parts.every((part) => part > 0n)).toBe(true);
    }
  });

  it("collapses to a single part rather than inventing zero-quantity fills", () => {
    expect(splitUnits(3n, 10, "seed:tiny")).toEqual([3n]);
  });

  it("refuses a non-positive total or a step count below one", () => {
    expect(() => splitUnits(0n, 2, "seed")).toThrow(/positive/);
    expect(() => splitUnits(10n, 0, "seed")).toThrow(/positive integer/);
  });
});
