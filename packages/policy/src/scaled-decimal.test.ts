import { describe, expect, it } from "vitest";

import {
  addDecimal,
  compareDecimal,
  divideFloor,
  floorToScale,
  fromScaled,
  isNegative,
  isPositive,
  isZero,
  minDecimal,
  multiplyDecimal,
  scaleOf,
  subtractDecimal,
  toScaled,
} from "./scaled-decimal";
import { dec } from "./test-support/fixtures";

// Kills the "money arithmetic rounded the wrong way" bug class. Every
// number this package compares against a limit is produced by one of these
// functions, so a rounding direction wrong here is a size above its bound
// everywhere, silently and consistently.
describe("divideFloor — rounds toward zero, never up", () => {
  it("truncates a non-terminating quotient rather than rounding it to nearest — 10/3 at 2dp is 3.33, and a round-to-nearest 3.33 would still be wrong at other scales", () => {
    expect(divideFloor(dec("10"), dec("3"), 2)).toBe("3.33");
  });

  it("truncates rather than rounding up at 5dp — 1/3 is 0.33333, never 0.33334", () => {
    expect(divideFloor(dec("1"), dec("3"), 5)).toBe("0.33333");
  });

  it("does not round a quotient up even when the next digit is 9 — 2/3 at 2dp is 0.66, and 0.67 would exceed the bound the numerator represents", () => {
    expect(divideFloor(dec("2"), dec("3"), 2)).toBe("0.66");
  });

  it("is exact when the quotient terminates, adding no spurious precision", () => {
    expect(divideFloor(dec("1000"), dec("100"), 14)).toBe("10");
    expect(divideFloor(dec("250"), dec("5"), 12)).toBe("50");
  });

  it("handles a fractional divisor without going through a float — 1/0.4 is exactly 2.5", () => {
    expect(divideFloor(dec("1"), dec("0.4"), 2)).toBe("2.5");
  });

  it("yields zero for a zero numerator rather than failing — a bound of zero is a real, tradable-as-nothing bound", () => {
    expect(divideFloor(dec("0"), dec("100"), 14)).toBe("0");
  });

  it("throws on a zero or negative divisor — a programmer error, since sizing.ts refuses those as diagnostics before calling in", () => {
    expect(() => divideFloor(dec("1"), dec("0"), 2)).toThrow();
    expect(() => divideFloor(dec("1"), dec("-2"), 2)).toThrow();
  });

  it("throws on a negative numerator rather than truncating it upward — bigint division rounds a negative toward zero, which is the wrong direction for a bound", () => {
    expect(() => divideFloor(dec("-1"), dec("2"), 2)).toThrow();
  });
});

describe("floorToScale — the venue-precision round-down", () => {
  it("rounds 1.09 down to 1 at zero decimal places, never up to 2", () => {
    expect(floorToScale(dec("1.09"), 0)).toBe("1");
  });

  it("rounds 1.999 down to 1.99 at 2dp — a round-half-up implementation would produce 2.00 and exceed the bound", () => {
    expect(floorToScale(dec("1.999"), 2)).toBe("1.99");
  });

  it("leaves a value already representable at the target scale untouched, inventing no precision", () => {
    expect(floorToScale(dec("2"), 4)).toBe("2");
    expect(floorToScale(dec("2.5"), 2)).toBe("2.5");
  });

  it("nests exactly: flooring to 12dp and then to 2dp equals flooring straight to 2dp, which is what lets sizing.ts keep the two steps separately observable", () => {
    const value = dec("333.333333333333333");
    expect(floorToScale(floorToScale(value, 12), 2)).toBe(floorToScale(value, 2));
    expect(floorToScale(value, 2)).toBe("333.33");
  });

  it("throws on a negative value rather than truncating it upward", () => {
    expect(() => floorToScale(dec("-1.5"), 0)).toThrow();
  });
});

describe("multiplyDecimal — exact, no rounding decision", () => {
  it("carries the sum of the operand scales so a notional is exact", () => {
    expect(multiplyDecimal(dec("2.5"), dec("4"))).toBe("10");
    expect(multiplyDecimal(dec("0.1"), dec("0.2"))).toBe("0.02");
    expect(multiplyDecimal(dec("8"), dec("100"))).toBe("800");
  });

  it("computes 0.1 * 0.2 as exactly 0.02 — the canonical float result is 0.020000000000000004", () => {
    expect(multiplyDecimal(dec("0.1"), dec("0.2"))).toBe("0.02");
  });

  it("applies a proportional rate exactly — 800 at 0.001 is 0.8", () => {
    expect(multiplyDecimal(dec("800"), dec("0.001"))).toBe("0.8");
  });
});

describe("compareDecimal — by value, never by string spelling", () => {
  it("treats differently-spelled equal values as equal", () => {
    expect(compareDecimal(dec("250.10"), dec("250.1"))).toBe(0);
    expect(compareDecimal(dec("0"), dec("0.000"))).toBe(0);
  });

  it('orders 9 below 10 — a lexicographic string comparison would order "9" above "10" and pass a limit check that should fail', () => {
    expect(compareDecimal(dec("9"), dec("10"))).toBe(-1);
    expect(compareDecimal(dec("10"), dec("9"))).toBe(1);
  });
});

describe("addDecimal / subtractDecimal", () => {
  it("adds and subtracts across differing scales without losing either operand's precision", () => {
    expect(addDecimal(dec("0.8"), dec("4"))).toBe("4.8");
    expect(subtractDecimal(dec("40"), dec("8.4"))).toBe("31.6");
    expect(subtractDecimal(dec("1000"), dec("200"))).toBe("800");
  });

  it("produces a canonical zero, not a negative zero, when two equal values cancel", () => {
    expect(subtractDecimal(dec("5"), dec("5"))).toBe("0");
  });
});

describe("sign and scale predicates", () => {
  it("recognizes zero in every spelling — a size of 0.000 is not a tradable size", () => {
    expect(isZero(dec("0"))).toBe(true);
    expect(isZero(dec("0.000"))).toBe(true);
    expect(isZero(dec("0.001"))).toBe(false);
  });

  it("is stable across repeated calls — a stateful /g regex would alternate its answer", () => {
    expect(isZero(dec("0.000"))).toBe(true);
    expect(isZero(dec("0.000"))).toBe(true);
    expect(isPositive(dec("1.5"))).toBe(true);
    expect(isPositive(dec("1.5"))).toBe(true);
  });

  it("separates zero from positive, so a zero bound cannot pass a 'strictly positive' guard", () => {
    expect(isPositive(dec("0"))).toBe(false);
    expect(isNegative(dec("0"))).toBe(false);
    expect(isNegative(dec("-0.5"))).toBe(true);
  });

  it("reports the scale a value is written at", () => {
    expect(scaleOf(dec("250"))).toBe(0);
    expect(scaleOf(dec("250.10"))).toBe(2);
  });
});

describe("toScaled / fromScaled round trip", () => {
  it("round-trips through an exact integer count of units", () => {
    expect(fromScaled(toScaled(dec("123.45"), 2), 2)).toBe("123.45");
    expect(toScaled(dec("1.09"), 2)).toBe(109n);
  });

  it("throws rather than silently dropping precision the target scale cannot hold", () => {
    expect(() => toScaled(dec("1.09"), 1)).toThrow();
  });
});

describe("minDecimal", () => {
  it("returns the smaller by value", () => {
    expect(minDecimal(dec("9"), dec("10"))).toBe("9");
    expect(minDecimal(dec("10"), dec("9"))).toBe("9");
  });
});
