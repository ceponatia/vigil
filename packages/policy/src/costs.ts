import { z } from "zod";
import type { DecimalString } from "@vigil/contracts";

import { scaleBoundedDecimalSchema } from "./config";
import { isNegative } from "./scaled-decimal";

/**
 * costs.ts — every cost standing between a quoted price and what a trade
 * actually costs, grouped by the one property that changes the arithmetic:
 * whether the cost is **already inside `executablePrice`** or is **charged
 * on top of it**.
 *
 * That grouping is structural rather than a comment because two different
 * calculations read this object and they must not read it the same way
 * (PR #41 review, finding 1):
 *
 * - **Net edge** subtracts *everything*. `expectedGrossEdgePerUnitQuote` is
 *   defined as the favorable move before any cost at all, so every
 *   component reduces it exactly once.
 * - **The capital and adverse-loss sizing bounds** subtract only
 *   `separatelyCharged`. An embedded cost is already reflected in the price
 *   the notional is computed from, so deducting it from available funds
 *   would charge it twice and under-size the trade. A separately-charged
 *   cost is real cash leaving on top of the notional, so a size that
 *   ignores it can exceed the funds that actually exist.
 *
 * Which group each cost belongs in:
 *
 * - **Spread is embedded.** `executablePrice` is the ask actually paid, and
 *   the ask already contains the half-spread. It reduces edge (gross edge is
 *   measured before costs) but it is not additional cash.
 * - **Slippage is separately charged.** A slippage allowance is by
 *   definition the amount a fill is expected to come in *worse than*
 *   `executablePrice`. If it materializes, more cash leaves than
 *   `quantity x executablePrice`. This is also the conservative placement of
 *   the one genuinely arguable component, which is the right default on the
 *   money path (`docs/resilience.md` §1).
 * - **A proportional venue fee and flat costs are separately charged.** A
 *   taker fee is billed on top of notional; gas and transfer fees are billed
 *   regardless of size.
 */
export const netEdgeCostsSchema = z.strictObject({
  /**
   * Costs already reflected in `executablePrice`. These reduce net edge and
   * must NOT be deducted from available funds or the adverse-loss budget —
   * the price the notional is computed from already contains them.
   */
  embedded: z.strictObject({
    /** Cost of crossing the spread, per unit of base asset. */
    spreadCostPerUnitQuote: scaleBoundedDecimalSchema,
  }),
  /**
   * Costs charged on top of the notional. These reduce net edge AND the
   * capital and adverse-loss bounds, because they are cash that leaves in
   * addition to `quantity x executablePrice`.
   */
  separatelyCharged: z.strictObject({
    /** Venue fee as a fraction of notional, e.g. `"0.0026"` for 26 bps. */
    proportionalFeeRate: scaleBoundedDecimalSchema,
    /** Budgeted fill worse than `executablePrice`, per unit of base asset. */
    slippageAllowancePerUnitQuote: scaleBoundedDecimalSchema,
    /** Flat per-trade costs — gas, transfer, fixed fees — that do not scale with size. */
    fixedCostsQuote: scaleBoundedDecimalSchema,
  }),
});

export type NetEdgeCosts = z.infer<typeof netEdgeCostsSchema>;

/**
 * The first negative cost component, or `undefined` when every component is
 * non-negative.
 *
 * Shared by `checkNetEdge` and `sizeTrade` rather than written twice: both
 * now consume this object, and a negative component is dangerous in both
 * directions. It inflates net edge past a threshold it does not clear, and
 * it *enlarges* the capital and loss bounds — a negative fee would let
 * sizing approve a trade costing more than the funds available.
 */
export function negativeCostComponent(costs: NetEdgeCosts): readonly [string, DecimalString] | undefined {
  return (
    [
      ["embedded.spreadCostPerUnitQuote", costs.embedded.spreadCostPerUnitQuote],
      ["separatelyCharged.proportionalFeeRate", costs.separatelyCharged.proportionalFeeRate],
      ["separatelyCharged.slippageAllowancePerUnitQuote", costs.separatelyCharged.slippageAllowancePerUnitQuote],
      ["separatelyCharged.fixedCostsQuote", costs.separatelyCharged.fixedCostsQuote],
    ] as const
  ).find(([, value]) => isNegative(value));
}
