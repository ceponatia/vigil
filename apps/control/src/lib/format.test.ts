import { describe, expect, it } from "vitest";

import { formatBaseUnits } from "./format";

// The defect this file kills: a display formatter that reaches for
// `Number()` or string slicing that mishandles the sign — the same class of
// bug `packages/ledger/src/base-units.test.ts` guards on the wire side.

describe("formatBaseUnits", () => {
  it("renders zero as the single digit 0, never -0", () => {
    expect(formatBaseUnits(0n, 6)).toBe("0");
  });

  it("renders a whole unit with no trailing fractional zeros", () => {
    expect(formatBaseUnits(1_000_000n, 6)).toBe("1");
  });

  it("renders one base unit at scale 6 as six decimal places", () => {
    expect(formatBaseUnits(1n, 6)).toBe("0.000001");
  });

  it("attaches the sign to the magnitude, not the whole part alone", () => {
    expect(formatBaseUnits(-1n, 6)).toBe("-0.000001");
  });

  it("trims trailing zeros inside the scale without losing significant digits", () => {
    expect(formatBaseUnits(1_100_000n, 6)).toBe("1.1");
  });

  it("handles scale 0 as a bare integer", () => {
    expect(formatBaseUnits(42n, 0)).toBe("42");
    expect(formatBaseUnits(-42n, 0)).toBe("-42");
  });

  it("renders an integer past Number.MAX_SAFE_INTEGER exactly, never off by one", () => {
    // 9_007_199_254_740_993n is 2^53 + 1 — the smallest integer a
    // `Number()`-based formatter cannot represent exactly, so it would
    // round this to …992 or …994 instead.
    expect(formatBaseUnits(9_007_199_254_740_993n, 0)).toBe("9007199254740993");
  });

  it("round-trips an eighteen-decimal amount without a wei off-by-one", () => {
    expect(formatBaseUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
  });

  it("renders a 30-digit amount at scale 18 with every digit intact", () => {
    // Computed by hand from the digits, not via a Number(): the whole part
    // is the leading 12 digits, the fraction is the trailing 18 with its
    // one trailing zero trimmed.
    expect(formatBaseUnits(123_456_789_012_345_678_901_234_567_890n, 18)).toBe("123456789012.34567890123456789");
  });
});
