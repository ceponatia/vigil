import { describe, expect, it } from "vitest";

import { compareDecimal } from "./scaled-decimal";
import { sizeTrade, SIZE_BOUNDS } from "./sizing";
import type { SizingInputs } from "./sizing";
import { dec, testConfig } from "./test-support/fixtures";

const config = testConfig();

/**
 * A baseline where no bound is close to binding, so each test can make
 * exactly one bound small and know that bound is why the size changed.
 * At a price of 100 and a stop distance of 5:
 *   fundsAvailable      1000 / 100 = 10
 *   exposureLimit       5000 / 100 = 50
 *   executableLiquidity              80
 *   adverseLossBudget    250 /   5 = 50
 */
const baseInputs: SizingInputs = {
  fundsAvailableQuote: dec("1000"),
  exposureHeadroomQuote: dec("5000"),
  executableLiquidityBase: dec("80"),
  adverseLossBudgetQuote: dec("250"),
  stopDistanceQuote: dec("5"),
  executablePrice: dec("100"),
};

const size = (overrides: Partial<SizingInputs> = {}, configOverrides: Readonly<Record<string, unknown>> = {}) =>
  sizeTrade({ inputs: { ...baseInputs, ...overrides }, config: testConfig(configOverrides) });

// ---------------------------------------------------------------------------
// The minimum of four bounds (docs/policy.md "Position sizing rule").
// ---------------------------------------------------------------------------
describe("sizeTrade — takes the minimum of the four bounds", () => {
  it("sizes to funds available when funds are the smallest bound", () => {
    const result = size({ fundsAvailableQuote: dec("1000") });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("10");
      expect(result.size.breakdown.bindingBounds).toEqual(["fundsAvailable"]);
    }
  });

  it("sizes to exposure headroom when the cap is the smallest bound", () => {
    const result = size({ exposureHeadroomQuote: dec("300") });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("3");
      expect(result.size.breakdown.bindingBounds).toEqual(["exposureLimit"]);
    }
  });

  it("sizes to executable liquidity when the venue cannot fill more", () => {
    const result = size({ executableLiquidityBase: dec("2.5") });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("2.5");
      expect(result.size.notionalQuote).toBe("250");
      expect(result.size.breakdown.bindingBounds).toEqual(["executableLiquidity"]);
    }
  });

  it("sizes to the adverse-loss budget when the planned loss is the smallest bound — budget 10 over a stop distance of 5 is 2 units, never more", () => {
    const result = size({ adverseLossBudgetQuote: dec("10") });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("2");
      expect(result.size.breakdown.bindingBounds).toEqual(["adverseLossBudget"]);
    }
  });

  it("reports every bound it evaluated, in SIZE_BOUNDS order, so a caller can explain the number rather than just repeat it", () => {
    const result = size();
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.breakdown.bounds.map((entry) => entry.bound)).toEqual([...SIZE_BOUNDS]);
      expect(result.size.breakdown.bounds.map((entry) => entry.maxQuantityBase)).toEqual(["10", "50", "80", "50"]);
    }
  });

  it("names every bound at the minimum on a tie, rather than an arbitrary first match", () => {
    const result = size({ executableLiquidityBase: dec("10") });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.breakdown.bindingBounds).toEqual(["fundsAvailable", "executableLiquidity"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Round DOWN to venue precision — never up (the acceptance criterion).
// ---------------------------------------------------------------------------
describe("sizeTrade — rounds down to venue precision", () => {
  it("truncates the minimum to the venue's supported precision instead of rounding to nearest", () => {
    // 1000 / 3 = 333.333…, which at 2dp is 333.33 and must never be 333.34.
    const result = size(
      {
        executablePrice: dec("3"),
        exposureHeadroomQuote: dec("1000000"),
        executableLiquidityBase: dec("999999"),
        adverseLossBudgetQuote: dec("100000"),
      },
      { minimumNotionalQuote: "1" },
    );
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("333.33");
      expect(result.size.breakdown.unroundedQuantityBase).toBe("333.33333333333333");
      expect(result.size.breakdown.precisionReduced).toBe(true);
      expect(result.size.notionalQuote).toBe("999.99");
    }
  });

  it("marks precisionReduced false when the minimum was already representable at venue precision, so 'rounding' is never claimed where none happened", () => {
    const result = size();
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.breakdown.precisionReduced).toBe(false);
      expect(result.size.breakdown.quantityBase).toBe(result.size.breakdown.unroundedQuantityBase);
    }
  });

  it.each([0, 1, 2, 4])(
    "never returns a quantity larger than the unrounded minimum at venue precision %i — this is the direction the whole rule turns on",
    (quantityScale) => {
      // 1000 / 7 is non-terminating, so every one of these scales actually rounds.
      const result = size(
        {
          executablePrice: dec("7"),
          exposureHeadroomQuote: dec("1000000"),
          executableLiquidityBase: dec("999999"),
          adverseLossBudgetQuote: dec("100000"),
        },
        { quantityScale, minimumNotionalQuote: "1", minimumQuantity: "0.0001" },
      );
      expect(result.outcome).toBe("sized");
      if (result.outcome === "sized") {
        const { quantityBase, unroundedQuantityBase } = result.size.breakdown;
        expect(compareDecimal(quantityBase, unroundedQuantityBase)).toBeLessThanOrEqual(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// MINIMUM_NOTIONAL — a skip, never a round-up.
// ---------------------------------------------------------------------------
describe("sizeTrade — below the minimum is a skip carrying MINIMUM_NOTIONAL", () => {
  it("refuses rather than raising the size when the result is below the minimum quantity", () => {
    const result = size({ executableLiquidityBase: dec("0.1") }, { minimumQuantity: "0.5", minimumNotionalQuote: "1" });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      // The refused branch still explains itself.
      expect(result.breakdown?.quantityBase).toBe("0.1");
      expect(result.breakdown?.bindingBounds).toEqual(["executableLiquidity"]);
    }
  });

  it("refuses when the notional is too small to be economically meaningful, even though the quantity itself clears the minimum", () => {
    const result = size({ executableLiquidityBase: dec("0.1") }, { minimumQuantity: "0.001", minimumNotionalQuote: "50" });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      // quantity 0.1 at a price of 100 is a notional of 10, under the 50 minimum.
      expect(result.refusal.detail).toContain("notional 10");
    }
  });

  it("applies the minimum to the ROUNDED quantity, not the unrounded one — 1.09 clears a 1.05 minimum but rounds to 1, which does not, and approving the pre-rounding number authorizes a trade below the minimum", () => {
    const result = size(
      { executableLiquidityBase: dec("1.09") },
      { quantityScale: 0, minimumQuantity: "1.05", minimumNotionalQuote: "1" },
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      expect(result.breakdown?.unroundedQuantityBase).toBe("1.09");
      expect(result.breakdown?.quantityBase).toBe("1");
      expect(result.breakdown?.precisionReduced).toBe(true);
    }
  });

  it("treats zero available funds as a skip with the binding bound named, not a crash and not an unbounded size", () => {
    const result = size({ fundsAvailableQuote: dec("0") });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      expect(result.breakdown?.quantityBase).toBe("0");
      expect(result.breakdown?.bindingBounds).toEqual(["fundsAvailable"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Input diagnostics — never dressed up as a policy decision.
// ---------------------------------------------------------------------------
describe("sizeTrade — refuses corrupt inputs as diagnostics, not policy decisions", () => {
  it.each(["0", "-1"])("refuses a non-positive executable price (%s) with NON_POSITIVE_PRICE", (price) => {
    const result = size({ executablePrice: dec(price) });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NON_POSITIVE_PRICE");
      expect(result.breakdown).toBeNull();
    }
  });

  it.each(["0", "-5"])("refuses a non-positive stop distance (%s) — the adverse-loss budget would bound no size at all", (distance) => {
    const result = size({ stopDistanceQuote: dec(distance) });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("NON_POSITIVE_STOP_DISTANCE");
    }
  });

  const negativeBoundCases: readonly (readonly [string, Partial<SizingInputs>])[] = [
    ["fundsAvailableQuote", { fundsAvailableQuote: dec("-1") }],
    ["exposureHeadroomQuote", { exposureHeadroomQuote: dec("-1") }],
    ["executableLiquidityBase", { executableLiquidityBase: dec("-1") }],
    ["adverseLossBudgetQuote", { adverseLossBudgetQuote: dec("-1") }],
  ];

  it.each(negativeBoundCases)(
    "refuses a negative %s as corrupt state rather than as a very small size",
    (field, overrides) => {
      const result = size(overrides);
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason.source).toBe("input");
        expect(result.refusal.reason.code).toBe("NEGATIVE_SIZE_BOUND");
        expect(result.refusal.detail).toContain(field);
      }
    },
  );

  it("refuses a malformed limit set as a config problem, distinguishable from a caller problem", () => {
    const result = sizeTrade({
      inputs: baseInputs,
      // PolicyConfig is an inferred type: it carries the field names but
      // not the sign refinements, so this object type-checks. That is
      // exactly why every check re-parses the config it is handed.
      config: { ...config, minimumQuantity: dec("-1") },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("MALFORMED_POLICY_CONFIG");
    }
  });

  it("never throws on any of these inputs", () => {
    expect(() => size({ executablePrice: dec("0") })).not.toThrow();
    expect(() => size({ stopDistanceQuote: dec("0") })).not.toThrow();
    expect(() => size({ fundsAvailableQuote: dec("-1") })).not.toThrow();
  });
});
