import { describe, expect, it } from "vitest";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { buildPositionPlan } from "./position-plan";
import { compareDecimal, fromScaled, scaleOf, toScaled } from "./scaled-decimal";

const d = (value: string): DecimalString => decimalStringSchema.parse(value);

function sumQuantities(tranches: ReadonlyArray<{ readonly quantity: DecimalString }>): DecimalString {
  const scale = Math.max(...tranches.map((tranche) => scaleOf(tranche.quantity)), 0);
  const totalUnits = tranches.reduce((sum, tranche) => sum + toScaled(tranche.quantity, scale), 0n);
  return fromScaled(totalUnits, scale);
}

// Kills the "tranches drift from the total" bug class: a plan built with
// float division (`totalQuantity / trancheCount`) or with a remainder
// silently dropped would either fail to reconcile against the total this
// plan claims, or size a real order for less than what was actually
// approved.
describe("buildPositionPlan — quantities always sum exactly to totalQuantity", () => {
  it("splits evenly when totalQuantity divides the tranche count with no remainder", () => {
    const plan = buildPositionPlan({ totalQuantity: d("3.0000"), trancheCount: 3, entryZone: { min: d("245.10"), max: d("248.10") } });
    expect(plan.tranches).toHaveLength(3);
    expect(plan.tranches.every((tranche) => compareDecimal(tranche.quantity, d("1.0000")) === 0)).toBe(true);
    expect(compareDecimal(sumQuantities(plan.tranches), plan.totalQuantity)).toBe(0);
  });

  it("distributes a remainder that does not divide evenly, rather than dropping or floating it away", () => {
    // "10" split three ways: 3.33... is not exact at any finite scale a
    // float would round to, but bigint division + remainder distribution
    // must still land on exactly "10".
    const plan = buildPositionPlan({ totalQuantity: d("10"), trancheCount: 3, entryZone: { min: d("1"), max: d("4") } });
    expect(compareDecimal(sumQuantities(plan.tranches), d("10"))).toBe(0);
    // Every quantity must be one of the two values integer division can
    // produce (base share, or base share + 1 unit) — never a third value.
    const quantities = new Set(plan.tranches.map((tranche) => tranche.quantity));
    expect(quantities.size).toBeLessThanOrEqual(2);
  });

  it("sums exactly for a quantity scale finer than the entry zone's price scale", () => {
    const plan = buildPositionPlan({ totalQuantity: d("1.00001"), trancheCount: 4, entryZone: { min: d("100"), max: d("101") } });
    expect(compareDecimal(sumQuantities(plan.tranches), d("1.00001"))).toBe(0);
  });
});

describe("buildPositionPlan — trigger prices always land inside the entry zone", () => {
  it("index 0 triggers at the zone's max, the last index at the zone's min, for a multi-tranche plan", () => {
    const plan = buildPositionPlan({ totalQuantity: d("3.0000"), trancheCount: 3, entryZone: { min: d("245.10"), max: d("248.10") } });
    expect(compareDecimal(plan.tranches[0]!.triggerPrice, d("248.10"))).toBe(0);
    expect(compareDecimal(plan.tranches[2]!.triggerPrice, d("245.10"))).toBe(0);
  });

  it("every trigger price is inside the closed interval [min, max], for a variety of tranche counts", () => {
    const entryZone = { min: d("100.00"), max: d("110.00") };
    for (const trancheCount of [1, 2, 3, 5, 7]) {
      const plan = buildPositionPlan({ totalQuantity: d("7.0000"), trancheCount, entryZone });
      for (const tranche of plan.tranches) {
        expect(compareDecimal(tranche.triggerPrice, entryZone.min)).toBeGreaterThanOrEqual(0);
        expect(compareDecimal(tranche.triggerPrice, entryZone.max)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("a single-tranche plan triggers at the zone's max and carries the whole quantity", () => {
    const plan = buildPositionPlan({ totalQuantity: d("2.5000"), trancheCount: 1, entryZone: { min: d("10"), max: d("12") } });
    expect(plan.tranches).toHaveLength(1);
    expect(compareDecimal(plan.tranches[0]!.triggerPrice, d("12"))).toBe(0);
    expect(compareDecimal(plan.tranches[0]!.quantity, d("2.5000"))).toBe(0);
  });
});

describe("buildPositionPlan — indexes and programmer-error guards", () => {
  it("indexes tranches 0..n-1 in order", () => {
    const plan = buildPositionPlan({ totalQuantity: d("5"), trancheCount: 5, entryZone: { min: d("1"), max: d("2") } });
    expect(plan.tranches.map((tranche) => tranche.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("throws for a non-positive or non-integer trancheCount — a programmer error in StrategyConfig, not external input", () => {
    expect(() => buildPositionPlan({ totalQuantity: d("1"), trancheCount: 0, entryZone: { min: d("1"), max: d("2") } })).toThrow();
    expect(() => buildPositionPlan({ totalQuantity: d("1"), trancheCount: 1.5, entryZone: { min: d("1"), max: d("2") } })).toThrow();
  });

  it("throws for an inverted entry zone (min > max)", () => {
    expect(() => buildPositionPlan({ totalQuantity: d("1"), trancheCount: 1, entryZone: { min: d("2"), max: d("1") } })).toThrow();
  });

  it("throws for a non-positive totalQuantity", () => {
    expect(() => buildPositionPlan({ totalQuantity: d("0"), trancheCount: 1, entryZone: { min: d("1"), max: d("2") } })).toThrow();
  });
});
