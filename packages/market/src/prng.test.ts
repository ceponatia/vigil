import { describe, expect, it } from "vitest";

import { createMulberry32, randomBigIntInRange, unitsToDecimalString } from "./prng";

describe("createMulberry32", () => {
  it("is deterministic: the same seed produces the exact same sequence of draws every time — the property the whole synthetic feed's replayability depends on", () => {
    const runA = createMulberry32(42);
    const runB = createMulberry32(42);
    const sequenceA = Array.from({ length: 10 }, () => runA());
    const sequenceB = Array.from({ length: 10 }, () => runB());
    expect(sequenceB).toEqual(sequenceA);
  });

  it("different seeds produce different sequences — proves the seed is actually wired into the state, not ignored", () => {
    const runA = createMulberry32(1);
    const runB = createMulberry32(2);
    const sequenceA = Array.from({ length: 5 }, () => runA());
    const sequenceB = Array.from({ length: 5 }, () => runB());
    expect(sequenceB).not.toEqual(sequenceA);
  });

  it("advances internal state across calls — a broken implementation that resets or ignores state would repeat the same draw forever", () => {
    const run = createMulberry32(7);
    const first = run();
    const second = run();
    expect(second).not.toBe(first);
  });

  it("every draw is a safe, non-negative 32-bit integer, never a float — the `>>> 0` reduction this depends on would be defeated by a stray division left in the implementation", () => {
    const run = createMulberry32(123456);
    for (let i = 0; i < 50; i += 1) {
      const draw = run();
      expect(Number.isInteger(draw)).toBe(true);
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("randomBigIntInRange", () => {
  it("maps a stubbed draw of 0 to the minimum of the range", () => {
    const stub = (): number => 0;
    expect(randomBigIntInRange(stub, -5n, 5n)).toBe(-5n);
  });

  it("wraps a draw larger than the span back into range via modulo", () => {
    // span is 11 (-5..5 inclusive); 23 % 11 === 1, so this must land on -4.
    const stub = (): number => 23;
    expect(randomBigIntInRange(stub, -5n, 5n)).toBe(-4n);
  });

  it("returns exactly min when min equals max, regardless of the draw", () => {
    const stub = (): number => 999;
    expect(randomBigIntInRange(stub, 7n, 7n)).toBe(7n);
  });

  it("never returns a value outside [min, max] across many draws from a real generator", () => {
    const run = createMulberry32(2024);
    for (let i = 0; i < 200; i += 1) {
      const value = randomBigIntInRange(run, -50n, 50n);
      expect(value >= -50n && value <= 50n).toBe(true);
    }
  });

  it("throws when max is less than min — an inverted range is a programmer error at the call site, not schema-legal external input", () => {
    const stub = (): number => 0;
    expect(() => randomBigIntInRange(stub, 5n, -5n)).toThrow();
  });
});

describe("unitsToDecimalString", () => {
  const cases: ReadonlyArray<{ readonly units: bigint; readonly scale: number; readonly expected: string }> = [
    { units: 0n, scale: 0, expected: "0" },
    { units: 0n, scale: 2, expected: "0.00" },
    { units: 5n, scale: 2, expected: "0.05" },
    { units: 105n, scale: 2, expected: "1.05" },
    { units: 99_999n, scale: 2, expected: "999.99" },
    { units: 250_000n, scale: 4, expected: "25.0000" },
    { units: -500n, scale: 2, expected: "-5.00" },
    { units: -5n, scale: 2, expected: "-0.05" },
    { units: 7n, scale: 0, expected: "7" },
  ];

  it.each(cases)("renders $units units at scale $scale as $expected", ({ units, scale, expected }) => {
    expect(unitsToDecimalString(units, scale)).toBe(expected);
  });

  it("never produces a value rejected by decimalStringSchema — catches a formatter that emits a leading zero, a trailing dot, or negative zero, which @vigil/contracts' money guard would reject at the next trust boundary", async () => {
    const { decimalStringSchema } = await import("@vigil/contracts");
    for (const { units, scale } of cases) {
      const rendered = unitsToDecimalString(units, scale);
      expect(decimalStringSchema.safeParse(rendered).success).toBe(true);
    }
  });

  it("never renders negative zero for a negative bigint whose magnitude is zero — bigint has no distinct -0n, but this guards the string-formatting path itself", () => {
    expect(unitsToDecimalString(-0n, 2)).toBe("0.00");
  });

  it("throws for a negative scale — a programmer error, not external input", () => {
    expect(() => unitsToDecimalString(100n, -1)).toThrow();
  });

  it("throws for a non-integer scale — a programmer error, not external input", () => {
    expect(() => unitsToDecimalString(100n, 1.5)).toThrow();
  });
});
