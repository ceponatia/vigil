import { describe, expect, it } from "vitest";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { addDecimal, compareDecimal, fromScaled, scaleOf, subtractDecimal, toScaled } from "./scaled-decimal";

const d = (value: string): DecimalString => decimalStringSchema.parse(value);

// Kills the "compares by string, not by value" bug class this whole
// helper exists to prevent: a naive string or Number()-based comparison
// would treat "250.10" and "250.1" as different amounts (or silently
// round through float imprecision), which is exactly the class of bug
// docs/resilience.md bans floating-point money to avoid.
describe("scaleOf and mixed-scale equivalence", () => {
  it("treats trailing zeros as insignificant for scale and for comparison", () => {
    expect(scaleOf(d("250"))).toBe(0);
    expect(scaleOf(d("250.0"))).toBe(1);
    expect(scaleOf(d("250.10"))).toBe(2);

    expect(compareDecimal(d("250"), d("250.0"))).toBe(0);
    expect(compareDecimal(d("250.0"), d("250.00"))).toBe(0);
    expect(compareDecimal(d("250.10"), d("250.1"))).toBe(0);
  });

  it("distinguishes amounts that only differ once trailing zeros are stripped", () => {
    expect(compareDecimal(d("250.11"), d("250.1"))).toBe(1);
    expect(compareDecimal(d("250.1"), d("250.11"))).toBe(-1);
    expect(compareDecimal(d("99"), d("100"))).toBe(-1);
  });

  it("compares negative amounts correctly at mixed scales", () => {
    expect(compareDecimal(d("-1.50"), d("-1.5"))).toBe(0);
    expect(compareDecimal(d("-2"), d("-1.99"))).toBe(-1);
    expect(compareDecimal(d("-1.99"), d("-2"))).toBe(1);
  });
});

describe("toScaled / fromScaled round-trip", () => {
  it("round-trips a representative set of amounts through a scale that can hold them, by value — the canonical spelling may drop a trailing zero the input carried", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["250", 2],
      ["250.1", 2],
      ["250.10", 4],
      ["0", 0],
      ["-3.5", 4],
      ["0.0001", 4],
    ];
    for (const [amount, scale] of cases) {
      const value = d(amount);
      expect(compareDecimal(fromScaled(toScaled(value, scale), scale), value)).toBe(0);
    }
  });

  it("renders the canonical spelling — no trailing fractional zeros, scale-padded input included", () => {
    expect(fromScaled(toScaled(d("250.10"), 4), 4)).toBe("250.1");
    expect(fromScaled(toScaled(d("250"), 3), 3)).toBe("250");
  });

  it("throws rather than silently truncating when a value carries more precision than the target scale can hold", () => {
    expect(() => toScaled(d("1.2345"), 2)).toThrow();
  });

  it("throws for a negative or non-integer scale on either function — a programmer error, never external input", () => {
    expect(() => toScaled(d("1.00"), -1)).toThrow();
    expect(() => toScaled(d("1.00"), 1.5)).toThrow();
    expect(() => fromScaled(100n, -1)).toThrow();
    expect(() => fromScaled(100n, 1.5)).toThrow();
  });
});

describe("addDecimal / subtractDecimal", () => {
  it("adds and subtracts correctly across mixed scales, matching the exact-integer arithmetic bigint gives no other choice but to get right", () => {
    expect(addDecimal(d("250.10"), d("0.05"))).toBe("250.15");
    expect(addDecimal(d("250"), d("0.5"))).toBe("250.5");
    expect(subtractDecimal(d("250.10"), d("2.00"))).toBe("248.1");
    expect(subtractDecimal(d("1"), d("2"))).toBe("-1");
  });

  it("subtracting to exactly zero never renders a negative-zero spelling", () => {
    expect(subtractDecimal(d("2.50"), d("2.5"))).toBe("0");
  });

  it("is the exact inverse of its own result — (a+b)-b is the same value as a, even though the canonical spelling may drop a's trailing zero", () => {
    const a = d("248.10");
    const b = d("3.0000");
    expect(compareDecimal(subtractDecimal(addDecimal(a, b), b), a)).toBe(0);
  });
});
