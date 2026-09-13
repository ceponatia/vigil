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

  it("handles an amount wider than IEEE-754 can represent exactly", () => {
    expect(formatBaseUnits(100_000_000_000_000_000n, 18)).toBe("0.1");
  });

  it("round-trips an eighteen-decimal amount without a wei off-by-one", () => {
    expect(formatBaseUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
  });
});
