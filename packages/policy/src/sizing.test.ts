import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal, multiplyDecimal } from "./scaled-decimal";
import { sizeTrade, SIZE_BOUNDS } from "./sizing";
import type { SizingInputs } from "./sizing";
import { dec, testConfig, testCosts, NO_COSTS } from "./test-support/fixtures";

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

const size = (
  overrides: Partial<SizingInputs> = {},
  configOverrides: Readonly<Record<string, unknown>> = {},
  costs = NO_COSTS,
) => sizeTrade({ inputs: { ...baseInputs, ...overrides }, costs, config: testConfig(configOverrides) });

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
// Cost-aware bounds (PR #41 review, finding 1). `fundsAvailableQuote` bounds
// the notional, but the cash that actually leaves is notional plus every
// separately-charged cost — so a size computed on notional alone can exceed
// the funds that exist, and a stop can consume the whole loss budget before
// costs are added. checkNetEdge runs afterward and asks about profitability,
// not solvency, so it restores neither bound.
// ---------------------------------------------------------------------------
describe("sizeTrade — separately-charged costs shrink the capital and loss bounds", () => {
  it("reduces the size so the true cash out fits the funds available — a proportional fee on a naive size of 10 would spend 1010 against 1000 available", () => {
    const rate = dec("0.01");
    const result = size({}, {}, testCosts({ separatelyCharged: { proportionalFeeRate: rate } }));
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("9.9");
      expect(result.size.breakdown.bindingBounds).toEqual(["fundsAvailable"]);

      // The property, asserted rather than asserted-about: notional plus the
      // fee is within the funds, and the size the old code produced was not.
      const cashOut = (quantity: string) => {
        const notional = multiplyDecimal(dec(quantity), dec("100"));
        return addDecimal(notional, multiplyDecimal(notional, rate));
      };
      expect(compareDecimal(cashOut(result.size.quantityBase), dec("1000"))).toBeLessThanOrEqual(0);
      expect(compareDecimal(cashOut("10"), dec("1000"))).toBe(1);
    }
  });

  it("reduces the size so the planned adverse loss fits its budget — a per-unit cost on a naive size of 50 would plan a 300 loss against a 250 budget", () => {
    const perUnit = dec("1");
    const result = size(
      { fundsAvailableQuote: dec("1000000") },
      {},
      testCosts({ separatelyCharged: { slippageAllowancePerUnitQuote: perUnit } }),
    );
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("41.66");
      expect(result.size.breakdown.bindingBounds).toEqual(["adverseLossBudget"]);

      const plannedLoss = (quantity: string) =>
        addDecimal(multiplyDecimal(dec(quantity), dec("5")), multiplyDecimal(dec(quantity), perUnit));
      expect(compareDecimal(plannedLoss(result.size.quantityBase), dec("250"))).toBeLessThanOrEqual(0);
      expect(compareDecimal(plannedLoss("50"), dec("250"))).toBe(1);
    }
  });

  it("skips entirely when flat costs exceed the funds available — a budget that cannot cover the fixed charge funds no trade, and the bound clamps to zero rather than going negative", () => {
    const result = size(
      { fundsAvailableQuote: dec("1") },
      {},
      testCosts({ separatelyCharged: { fixedCostsQuote: dec("5") } }),
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      expect(result.breakdown?.quantityBase).toBe("0");
      expect(result.breakdown?.bindingBounds).toEqual(["fundsAvailable"]);
    }
  });

  it("leaves the bounds untouched for an EMBEDDED cost of the same magnitude — it is already inside executablePrice, and deducting it again would charge it twice and under-size the trade", () => {
    const magnitude = dec("50");
    const embedded = size(
      { adverseLossBudgetQuote: dec("100000") },
      {},
      testCosts({ embedded: { spreadCostPerUnitQuote: magnitude } }),
    );
    const separatelyCharged = size(
      { adverseLossBudgetQuote: dec("100000") },
      {},
      testCosts({ separatelyCharged: { slippageAllowancePerUnitQuote: magnitude } }),
    );

    expect(embedded.outcome).toBe("sized");
    expect(separatelyCharged.outcome).toBe("sized");
    if (embedded.outcome === "sized" && separatelyCharged.outcome === "sized") {
      // Identical to the zero-cost baseline: embedded costs are invisible here.
      expect(embedded.size.quantityBase).toBe("10");
      // The same number, charged on top, genuinely shrinks the size.
      expect(separatelyCharged.size.quantityBase).toBe("6.66");
    }
  });

  it("refuses a negative cost component, which would ENLARGE the capital bound rather than shrink it", () => {
    const result = size({}, {}, testCosts({ separatelyCharged: { fixedCostsQuote: dec("-1000") } }));
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NEGATIVE_COST_COMPONENT");
    }
  });

  it("reproduces the pre-cost bounds exactly when nothing is charged, so the cost model added no drift to the baseline", () => {
    const result = size();
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.breakdown.bounds.map((entry) => entry.maxQuantityBase)).toEqual(["10", "50", "80", "50"]);
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

  it("sizes a quantity sitting exactly ON the minimum quantity — docs/policy.md skips what 'falls below' the minimum, so the boundary itself is tradable and must not be skipped", () => {
    // Liquidity 0.5 is the binding bound and equals minimumQuantity exactly.
    // minimumNotionalQuote is dropped to 1 so only the quantity comparison
    // is on trial here.
    const result = size({ executableLiquidityBase: dec("0.5") }, { minimumNotionalQuote: "1" });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("0.5");
      expect(result.size.breakdown.bindingBounds).toEqual(["executableLiquidity"]);
    }
  });

  it("sizes a notional sitting exactly ON the minimum notional — same boundary, the other comparison", () => {
    // 0.5 at a price of 100 is a notional of exactly 50. minimumQuantity is
    // dropped to 0.001 so the quantity comparison cannot be what decides it.
    const result = size({ executableLiquidityBase: dec("0.5") }, { minimumQuantity: "0.001" });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.notionalQuote).toBe("50");
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

  it("refuses a ZERO exposure headroom as a skipped gate, not as a MINIMUM_NOTIONAL skip — checkExposure never returns a zero headroom, so a zero arriving here means the exposure gate did not run, and filing that under a policy code would lose both the cap's name and the fact the check was missed", () => {
    const result = size({ exposureHeadroomQuote: dec("0") });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NON_POSITIVE_EXPOSURE_HEADROOM");
      expect(result.refusal.reason.code).not.toBe("MINIMUM_NOTIONAL");
    }
  });

  it("still reports a NEGATIVE exposure headroom as a corrupt bound, so the two headroom failures stay distinguishable", () => {
    const result = size({ exposureHeadroomQuote: dec("-1") });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("NEGATIVE_SIZE_BOUND");
    }
  });

  it("leaves the other three bounds alone at zero — no funds, no liquidity, and no loss budget are all real states that skip with MINIMUM_NOTIONAL rather than reporting a skipped gate", () => {
    for (const overrides of [
      { fundsAvailableQuote: dec("0") },
      { executableLiquidityBase: dec("0") },
      { adverseLossBudgetQuote: dec("0") },
    ]) {
      const result = size(overrides);
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason.source).toBe("policy");
        expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
      }
    }
  });

  it("refuses a decimal carrying more fractional digits than the arithmetic will walk, rather than stalling the allocator in bigint math on a pathological venue value", () => {
    const pathological = dec(`0.${"0".repeat(200)}1`);
    const result = size({ executablePrice: pathological });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("MALFORMED_INPUT");
    }
  });

  it("accepts a decimal exactly AT the scale bound, so the guard rejects only what it must — an off-by-one here would refuse legitimate venue precision", () => {
    const atBound = dec(`0.${"0".repeat(35)}1`); // exactly 36 fractional digits
    // A stop distance this small makes the adverse-loss bound enormous, so
    // funds available (10 units) is still the binding bound and the trade
    // sizes normally. The point is that the scale guard let it through.
    const result = size({ stopDistanceQuote: atBound });
    expect(result.outcome).toBe("sized");
    if (result.outcome === "sized") {
      expect(result.size.quantityBase).toBe("10");
      expect(result.size.breakdown.bindingBounds).toEqual(["fundsAvailable"]);
    }
  });

  it("refuses a malformed limit set as a config problem, distinguishable from a caller problem", () => {
    const result = sizeTrade({
      inputs: baseInputs,
      costs: NO_COSTS,
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
