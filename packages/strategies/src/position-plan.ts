import { z } from "zod";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { compareDecimal, fromScaled, scaleOf, toScaled } from "./scaled-decimal";

/**
 * position-plan.ts — the staged position plan a candidate carries
 * (docs/product.md TASK-06: "Tranches are bounded, idempotent
 * position-plan steps, not fresh unlimited authorizations."). A tranche
 * is a bounded slice of `totalQuantity` triggered at a specific price
 * inside the candidate's entry zone; splitting is exact bigint
 * arithmetic so the tranches always sum back to exactly what was
 * proposed, never a rounded approximation that drifts from it.
 */

export const trancheSchema = z.object({
  index: z.number().int().nonnegative(),
  quantity: decimalStringSchema,
  triggerPrice: decimalStringSchema,
});

export type Tranche = z.infer<typeof trancheSchema>;

export const positionPlanSchema = z.object({
  totalQuantity: decimalStringSchema,
  tranches: z.array(trancheSchema).min(1),
});

export type PositionPlan = z.infer<typeof positionPlanSchema>;

export type BuildPositionPlanParams = {
  readonly totalQuantity: DecimalString;
  readonly trancheCount: number;
  readonly entryZone: { readonly min: DecimalString; readonly max: DecimalString };
};

/**
 * Splits `totalQuantity` into `trancheCount` tranches whose quantities
 * sum exactly to `totalQuantity`, each triggered at a distinct price
 * spread through `entryZone` — the first tranche (index 0) at the top of
 * the zone (`max`, the first sign of a pullback), the last at the bottom
 * (`min`, the deepest add) — and every trigger price inside the closed
 * interval `[min, max]`.
 *
 * `trancheCount` and `entryZone` are `StrategyConfig`/generator-derived
 * values, never untrusted external input, so an invalid `trancheCount`
 * (not a positive integer) or an inverted zone (`min > max`) is a
 * programmer error and throws rather than returning a diagnostic —
 * consistent with this package's other internal arithmetic helpers
 * (`scaled-decimal.ts`).
 */
export function buildPositionPlan(params: BuildPositionPlanParams): PositionPlan {
  if (!Number.isInteger(params.trancheCount) || params.trancheCount < 1) {
    throw new Error(`buildPositionPlan: trancheCount must be a positive integer, got ${String(params.trancheCount)}`);
  }
  if (compareDecimal(params.entryZone.min, params.entryZone.max) > 0) {
    throw new Error(`buildPositionPlan: entryZone.min (${params.entryZone.min}) must be <= entryZone.max (${params.entryZone.max})`);
  }

  const quantityScale = scaleOf(params.totalQuantity);
  const totalUnits = toScaled(params.totalQuantity, quantityScale);
  if (totalUnits <= 0n) {
    throw new Error(`buildPositionPlan: totalQuantity (${params.totalQuantity}) must be strictly positive`);
  }

  const trancheCount = BigInt(params.trancheCount);
  const baseShareUnits = totalUnits / trancheCount;
  const remainderUnits = totalUnits % trancheCount;

  const priceScale = Math.max(scaleOf(params.entryZone.min), scaleOf(params.entryZone.max));
  const minPriceUnits = toScaled(params.entryZone.min, priceScale);
  const maxPriceUnits = toScaled(params.entryZone.max, priceScale);
  const spanUnits = maxPriceUnits - minPriceUnits;
  const lastIndex = params.trancheCount - 1;

  const tranches: Tranche[] = [];
  for (let index = 0; index < params.trancheCount; index += 1) {
    // The first `remainderUnits` tranches absorb the one-unit-at-a-time
    // remainder from integer division, so the sum is exact rather than
    // short by `remainderUnits` units.
    const quantityUnits = baseShareUnits + (BigInt(index) < remainderUnits ? 1n : 0n);

    // Walks from `max` (index 0) down to `min` (index lastIndex) in equal
    // steps of the zone's span; a single-tranche plan triggers at `max`.
    const triggerUnits =
      lastIndex === 0 ? maxPriceUnits : maxPriceUnits - (spanUnits * BigInt(index)) / BigInt(lastIndex);

    tranches.push({
      index,
      quantity: fromScaled(quantityUnits, quantityScale),
      triggerPrice: fromScaled(triggerUnits, priceScale),
    });
  }

  return positionPlanSchema.parse({ totalQuantity: params.totalQuantity, tranches });
}
