import { z } from "zod";
import type { DecimalString } from "@vigil/contracts";

import { policyConfigSchema, refusalForParseError, scaleBoundedDecimalSchema } from "./config";
import { inputRefusal, policyRefusal, type PolicyRefusal } from "./diagnostics";
import { compareDecimal, divideFloor, floorToScale, isNegative, isPositive, minDecimal, multiplyDecimal } from "./scaled-decimal";

/**
 * sizing.ts — `docs/policy.md`'s position sizing rule, verbatim:
 *
 * > A sized trade is the **minimum** of: funds actually available, the
 * > applicable exposure limit, executable liquidity at the venue, and the
 * > planned adverse-loss budget. Round down to the venue's supported
 * > precision. If the result falls below the venue's minimum, or is too
 * > small to be economically meaningful, skip the trade — never round up
 * > beyond its risk budget to make it tradable.
 *
 * Four properties of the implementation carry that rule, and each one is a
 * place where plausible-looking code authorizes more than the rule allows:
 *
 * 1. **The four bounds are a fixed record, not a list.** `Math.min()` of an
 *    empty array is `Infinity`, and a bound accidentally omitted from a
 *    caller-built array is an unbounded size. Here every bound is a
 *    required field, so "no bounds" is not representable.
 *
 * 2. **Every conversion floors.** Three of the four bounds are
 *    quote-currency amounts that become a maximum *quantity* by division.
 *    A quotient rounded to nearest — or, worse, computed as a float —
 *    exceeds its own bound in the last place. `divideFloor` truncates
 *    downward, so each converted bound is at most what the bound actually
 *    covers.
 *
 * 3. **Round down once, then re-check the minimum.** Venue precision is
 *    applied to the minimum of the four, and the `MINIMUM_NOTIONAL` test
 *    runs on the *rounded* quantity. Checking before rounding is the subtle
 *    version of the same bug: a size of `1.09` that passes a `1.05`
 *    minimum, then rounds to `1.0`, is a trade below the minimum that was
 *    approved by a check that no longer describes it.
 *
 * 4. **Below the minimum is a refusal carrying `MINIMUM_NOTIONAL`.** Never
 *    a clamp. There is no branch in this file that raises a quantity.
 *
 * The result also reports which bound actually bound the size. The
 * allocator and the opportunity journal both need it — "we bought less than
 * proposed" is not an explanation, and a caller that can only see the final
 * number cannot produce one. Ties report every bound at the minimum rather
 * than an arbitrary first match.
 */

/**
 * The four bounds of the sizing rule, in the order `docs/policy.md` names
 * them. Exported so a caller can render or switch over them without
 * re-typing the strings.
 */
export const SIZE_BOUNDS = ["fundsAvailable", "exposureLimit", "executableLiquidity", "adverseLossBudget"] as const;

export type SizeBound = (typeof SIZE_BOUNDS)[number];

/**
 * Extra digits carried through the bound conversions before the venue
 * round-down is applied.
 *
 * Dividing straight to `quantityScale` would fold the precision round-down
 * into each conversion, leaving no way to tell whether venue precision or a
 * capital bound is what actually limited the size. Flooring at a finer
 * scale first and then flooring to `quantityScale` yields the identical
 * final quantity — nested flooring at decreasing scales is exact — while
 * keeping the two steps separately observable.
 *
 * This is a representational choice about intermediate arithmetic, not an
 * owner limit: every step floors, so no amount of intermediate precision
 * can push a size above a bound.
 */
const WORKING_SCALE_GUARD_DIGITS = 12;

/**
 * The caller-supplied state the four bounds are derived from. Field names
 * carry the unit, and that is load-bearing: mixing a quote-currency amount
 * with a base-asset quantity produces a minimum that is not a bound in
 * either unit, and it produces it silently. `Quote` means quote currency,
 * `Base` means base-asset quantity.
 */
export const sizingInputsSchema = z.strictObject({
  /** Unreserved capital the account can actually spend, in quote currency. */
  fundsAvailableQuote: scaleBoundedDecimalSchema,
  /** Remaining headroom under the binding exposure cap, in quote currency — `checkExposure`'s `headroomQuote`. */
  exposureHeadroomQuote: scaleBoundedDecimalSchema,
  /** Quantity the venue can actually fill at or inside the executable price, in base units. */
  executableLiquidityBase: scaleBoundedDecimalSchema,
  /** Planned adverse loss this trade may cost if the stop is hit, in quote currency. */
  adverseLossBudgetQuote: scaleBoundedDecimalSchema,
  /** Quote-currency loss per unit of base asset if the stop is hit — entry price less stop price. */
  stopDistanceQuote: scaleBoundedDecimalSchema,
  /** The price the size is computed against, quote currency per unit of base asset. */
  executablePrice: scaleBoundedDecimalSchema,
});

export type SizingInputs = z.infer<typeof sizingInputsSchema>;

const sizingParamsSchema = z.strictObject({
  inputs: sizingInputsSchema,
  config: policyConfigSchema,
});

export type SizeTradeParams = z.infer<typeof sizingParamsSchema>;

/** One bound, converted to the maximum base-asset quantity it permits. */
export type BoundQuantity = {
  readonly bound: SizeBound;
  readonly maxQuantityBase: DecimalString;
};

/**
 * Everything needed to explain a size, whether it was approved or skipped.
 * Carried on both branches for exactly that reason.
 */
export type SizingBreakdown = {
  /** All four bounds, converted to base-asset quantities, in `SIZE_BOUNDS` order. */
  readonly bounds: readonly BoundQuantity[];
  /** Every bound equal to the minimum. More than one on a tie; never empty. */
  readonly bindingBounds: readonly SizeBound[];
  /** The minimum of the four, before venue precision is applied. */
  readonly unroundedQuantityBase: DecimalString;
  /** The same quantity after rounding DOWN to `quantityScale`. */
  readonly quantityBase: DecimalString;
  /** True when the venue's precision — not a capital bound — is what reduced the size. */
  readonly precisionReduced: boolean;
  readonly quantityScale: number;
};

export type SizedTrade = {
  readonly quantityBase: DecimalString;
  readonly notionalQuote: DecimalString;
  readonly breakdown: SizingBreakdown;
};

export type SizingResult =
  | { readonly outcome: "sized"; readonly size: SizedTrade }
  | {
      readonly outcome: "refused";
      readonly refusal: PolicyRefusal;
      /** `null` when the inputs were too malformed for any bound to be computed. */
      readonly breakdown: SizingBreakdown | null;
    };

/**
 * Applies the sizing rule. Pure, exact, and never throwing on schema-legal
 * input: every sign and zero precondition the arithmetic helpers require is
 * refused here as a reason-coded diagnostic first.
 *
 * Refusals split into two vocabularies on purpose (see `diagnostics.ts`).
 * A size below the minimum is a genuine policy skip carrying
 * `MINIMUM_NOTIONAL`. A non-positive price, a non-positive stop distance,
 * or a negative bound is a caller or state bug — answering those with a
 * policy code would write a decision into the journal that policy never
 * made.
 */
export function sizeTrade(params: SizeTradeParams): SizingResult {
  const parsed = sizingParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { outcome: "refused", refusal: refusalForParseError(parsed.error), breakdown: null };
  }
  const { inputs, config } = parsed.data;

  if (!isPositive(inputs.executablePrice)) {
    return {
      outcome: "refused",
      refusal: inputRefusal(
        "NON_POSITIVE_PRICE",
        `executable price ${inputs.executablePrice} must be strictly positive; no quantity is derivable from a zero or negative price`,
      ),
      breakdown: null,
    };
  }

  if (!isPositive(inputs.stopDistanceQuote)) {
    return {
      outcome: "refused",
      refusal: inputRefusal(
        "NON_POSITIVE_STOP_DISTANCE",
        `stop distance ${inputs.stopDistanceQuote} must be strictly positive; a zero or negative distance makes the adverse-loss budget bound no size at all`,
      ),
      breakdown: null,
    };
  }

  const negativeBound = (
    [
      ["fundsAvailableQuote", inputs.fundsAvailableQuote],
      ["exposureHeadroomQuote", inputs.exposureHeadroomQuote],
      ["executableLiquidityBase", inputs.executableLiquidityBase],
      ["adverseLossBudgetQuote", inputs.adverseLossBudgetQuote],
    ] as const
  ).find(([, value]) => isNegative(value));

  if (negativeBound !== undefined) {
    return {
      outcome: "refused",
      refusal: inputRefusal(
        "NEGATIVE_SIZE_BOUND",
        `sizing bound "${negativeBound[0]}" is ${negativeBound[1]}; a negative bound is corrupt state, not a very small size`,
      ),
      breakdown: null,
    };
  }

  // Exposure headroom is the one bound whose zero is not a real bound.
  // Zero funds, zero liquidity, and a zero loss budget are all legitimate
  // states that should skip with MINIMUM_NOTIONAL. But `checkExposure`
  // refuses a cap with no headroom before it ever returns one, so a zero
  // arriving here means that gate was skipped. Answering it with a policy
  // code would file a breached cap — or a missing check — as a
  // minimum-size skip, losing both the cap's name and the fact that the
  // gate never ran. The money outcome is the same either way; the
  // journal's reason code is what this protects. `sizeTrade` is on the
  // public surface, so a caller can reach it without `evaluateProposal`.
  if (!isPositive(inputs.exposureHeadroomQuote)) {
    return {
      outcome: "refused",
      refusal: inputRefusal(
        "NON_POSITIVE_EXPOSURE_HEADROOM",
        `exposure headroom is ${inputs.exposureHeadroomQuote}; checkExposure refuses a cap with no headroom before returning one, so a non-positive headroom here means the exposure gate was skipped`,
      ),
      breakdown: null,
    };
  }

  const workingScale = config.quantityScale + WORKING_SCALE_GUARD_DIGITS;

  // Each quote-currency bound becomes a maximum quantity by flooring
  // division; executable liquidity is already a quantity and is taken as
  // given, at whatever precision the venue reported it.
  const fundsBound = divideFloor(inputs.fundsAvailableQuote, inputs.executablePrice, workingScale);
  const exposureBound = divideFloor(inputs.exposureHeadroomQuote, inputs.executablePrice, workingScale);
  const liquidityBound = inputs.executableLiquidityBase;
  const lossBudgetBound = divideFloor(inputs.adverseLossBudgetQuote, inputs.stopDistanceQuote, workingScale);

  const bounds: readonly BoundQuantity[] = [
    { bound: "fundsAvailable", maxQuantityBase: fundsBound },
    { bound: "exposureLimit", maxQuantityBase: exposureBound },
    { bound: "executableLiquidity", maxQuantityBase: liquidityBound },
    { bound: "adverseLossBudget", maxQuantityBase: lossBudgetBound },
  ];

  // Seeded with a named bound, not a sentinel and not an indexed lookup: a
  // sentinel seed (`Infinity`, or a "no bound yet" null) is precisely where
  // an unbounded size would come from if the list were ever empty, and the
  // list cannot be empty because each member is a required input above.
  const unroundedQuantityBase = bounds.reduce(
    (smallest, candidate) => minDecimal(smallest, candidate.maxQuantityBase),
    fundsBound,
  );

  const bindingBounds = bounds
    .filter((entry) => compareDecimal(entry.maxQuantityBase, unroundedQuantityBase) === 0)
    .map((entry) => entry.bound);

  const quantityBase = floorToScale(unroundedQuantityBase, config.quantityScale);

  const breakdown: SizingBreakdown = {
    bounds,
    bindingBounds,
    unroundedQuantityBase,
    quantityBase,
    precisionReduced: compareDecimal(quantityBase, unroundedQuantityBase) < 0,
    quantityScale: config.quantityScale,
  };

  // Deliberately after the round-down: the rounded quantity is the one that
  // would actually be traded, so it is the one the minimum applies to.
  if (compareDecimal(quantityBase, config.minimumQuantity) < 0) {
    return {
      outcome: "refused",
      refusal: policyRefusal(
        "MINIMUM_NOTIONAL",
        `sized quantity ${quantityBase} (bound by ${bindingBounds.join(", ")}, rounded down to ${String(config.quantityScale)} dp) is below the configured minimum quantity ${config.minimumQuantity}; skipped rather than rounded up`,
      ),
      breakdown,
    };
  }

  const notionalQuote = multiplyDecimal(quantityBase, inputs.executablePrice);

  if (compareDecimal(notionalQuote, config.minimumNotionalQuote) < 0) {
    return {
      outcome: "refused",
      refusal: policyRefusal(
        "MINIMUM_NOTIONAL",
        `sized notional ${notionalQuote} (quantity ${quantityBase} at ${inputs.executablePrice}) is below the configured minimum notional ${config.minimumNotionalQuote}; too small to be economically meaningful, so skipped rather than rounded up`,
      ),
      breakdown,
    };
  }

  return { outcome: "sized", size: { quantityBase, notionalQuote, breakdown } };
}
