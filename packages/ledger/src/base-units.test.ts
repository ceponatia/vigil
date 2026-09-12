import { decimalStringSchema } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import { fromBaseUnits, toBaseUnits, MAX_ASSET_SCALE } from "./base-units";

// The defect this file kills: money entering the ledger through a float.
// Every case below is one that `parseFloat`, `Number()`, or `toFixed()`
// would get wrong — silently, and in the direction of spending money that
// was never authorized.

const conversions: ReadonlyArray<{
  name: string;
  decimal: string;
  scale: number;
  base: bigint;
  catches: string;
}> = [
  {
    name: "zero",
    decimal: "0",
    scale: 6,
    base: 0n,
    catches: "a conversion that padded before checking the sign would produce -0 base units",
  },
  {
    name: "a whole unit at scale 6",
    decimal: "1",
    scale: 6,
    base: 1_000_000n,
    catches: "a conversion that forgot to scale an amount with no fractional part would reserve one millionth of the intended size",
  },
  {
    name: "one base unit at scale 6",
    decimal: "0.000001",
    scale: 6,
    base: 1n,
    catches: "a conversion that dropped the leading zero of the fraction would inflate the amount tenfold",
  },
  {
    name: "a negative base unit",
    decimal: "-0.000001",
    scale: 6,
    base: -1n,
    catches: "a conversion that applied the sign to the whole part only would return +1 for a negative amount",
  },
  {
    name: "trailing zeros inside the scale",
    decimal: "1.100",
    scale: 6,
    base: 1_100_000n,
    catches: "a conversion that treated fraction length as the scale would misplace the decimal point",
  },
  {
    name: "explicit trailing zeros beyond the scale",
    decimal: "1.100",
    scale: 2,
    base: 110n,
    catches: "a conversion that refused any fraction longer than the scale would reject an amount it can represent exactly",
  },
  {
    name: "an eighteen-decimal amount",
    decimal: "0.1",
    scale: 18,
    base: 100_000_000_000_000_000n,
    catches: "a conversion through a JS number would return 100000000000000001 or 99999999999999997 for 0.1 at wei precision",
  },
  {
    name: "an amount wider than IEEE-754 can represent",
    decimal: "12345678901234567890.123456789",
    scale: 9,
    base: 12_345_678_901_234_567_890_123_456_789n,
    catches: "any float-backed conversion, which loses the low-order digits of this amount entirely",
  },
];

describe("toBaseUnits", () => {
  it.each(conversions)("converts $name exactly — catches: $catches", ({ decimal, scale, base }) => {
    const result = toBaseUnits(decimalStringSchema.parse(decimal), scale);

    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.base).toBe(base);
    }
  });

  it("refuses an amount with more precision than the scale holds, rather than rounding it — a conversion that rounded would turn a rejected order into a cheaper one, and one that truncated would spend a fraction nobody authorized", () => {
    const result = toBaseUnits(decimalStringSchema.parse("1.005"), 2);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason).toEqual({ source: "ledger", code: "UNREPRESENTABLE_PRECISION" });
    }
  });

  it("refuses a scale outside the representable range instead of throwing — a scale read from a future asset record must not take down the caller", () => {
    const amount = decimalStringSchema.parse("1");

    expect(() => toBaseUnits(amount, MAX_ASSET_SCALE + 1)).not.toThrow();
    const tooLarge = toBaseUnits(amount, MAX_ASSET_SCALE + 1);
    const negative = toBaseUnits(amount, -1);

    expect(tooLarge.outcome).toBe("refused");
    expect(negative.outcome).toBe("refused");
    if (tooLarge.outcome === "refused") {
      expect(tooLarge.refusal.reason.code).toBe("SCALE_OUT_OF_RANGE");
    }
  });
});

describe("fromBaseUnits", () => {
  it.each(conversions)("renders $name back to a canonical decimal string that parses — catches: $catches", ({ scale, base }) => {
    const rendered = fromBaseUnits(base, scale);

    expect(rendered.outcome).toBe("ok");
    if (rendered.outcome === "ok") {
      expect(decimalStringSchema.safeParse(rendered.amount).success).toBe(true);
      // Round trip: whatever it renders must convert back to the same
      // integer. A renderer that dropped a significant digit, or padded the
      // wrong side, fails here even when its output still looks like money.
      const back = toBaseUnits(rendered.amount, scale);
      expect(back.outcome).toBe("ok");
      if (back.outcome === "ok") {
        expect(back.base).toBe(base);
      }
    }
  });

  it("renders zero as 0 and never as -0 — negative zero would put two spellings of one amount on the wire, and decimalStringSchema rejects the second", () => {
    const rendered = fromBaseUnits(0n, 18);

    expect(rendered.outcome).toBe("ok");
    if (rendered.outcome === "ok") {
      expect(rendered.amount).toBe("0");
    }
  });

  it("strips trailing zeros from the fraction only — a blanket trailing-zero strip over the whole rendered string would render ten units as one", () => {
    const tenUnits = fromBaseUnits(10_000_000n, 6);
    const fractional = fromBaseUnits(1_100_000n, 6);

    expect(tenUnits.outcome).toBe("ok");
    expect(fractional.outcome).toBe("ok");
    if (tenUnits.outcome === "ok" && fractional.outcome === "ok") {
      expect(tenUnits.amount).toBe("10");
      expect(fractional.amount).toBe("1.1");
    }
  });
});
