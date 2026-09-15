import { decimalStringSchema } from "@vigil/contracts";
import type { AssetId, DecimalString } from "@vigil/contracts";
import type { StoredPositionPlan } from "@vigil/db";
import type { EntryZone } from "@vigil/policy";

import { executionRefusal, type ExecutionRefusal } from "./diagnostics";
import type { ThesisTarget } from "./revalidate";

/**
 * position-plan.ts — turning the durable terms of a staged plan into the
 * two figures the pre-dispatch gate measures against.
 *
 * `position_plans` is where the entry zone and the thesis exit price live
 * (`packages/db/src/schema/decisions.ts`). They are stored as decimal text,
 * under the id `approved_intents.position_plan_id` names, and they are the
 * inputs a restarted process has no memory of: the authorization records the
 * *result* of the approval — the gross, the cost breakdown, the hurdle — and
 * not the terms that result was derived from.
 *
 * This module is pure, and everything it does is a check rather than a
 * translation, for one reason: a plan is fetched **by id**, so the row that
 * comes back is whatever that id points at. The id is `NOT NULL` text on the
 * intent with no foreign key behind it yet, which means "the plan for this
 * intent" is an application claim and not a database one. So the terms are
 * re-checked against the instrument actually being dispatched before
 * anything reads them (`docs/resilience.md` §5: identity is re-validated
 * after parsing), and a plan that cannot supply usable terms refuses the
 * dispatch instead of supplying approximate ones.
 *
 * What is deliberately NOT checked here: that `entryZone.min <= max`.
 * `@vigil/policy`'s `entryZoneSchema` refines that and `checkEntryZone`
 * parses through it, so an inverted band refuses every dispatch it is used
 * on, with policy's own diagnostic. Restating the rule here would give the
 * same input two different refusals depending on which check ran first.
 */

/** The asset pair one dispatch trades. */
export type Instrument = {
  readonly baseAssetId: AssetId;
  readonly quoteAssetId: AssetId;
};

/** The plan's own terms: the band an entry may be taken in, and what it is aimed at. */
export type PositionPlanTerms = {
  readonly entryZone: EntryZone;
  readonly thesis: ThesisTarget;
};

export type PositionPlanTermsResult =
  | { readonly outcome: "terms"; readonly terms: PositionPlanTerms }
  | { readonly outcome: "refused"; readonly refusal: ExecutionRefusal };

/** An instrument id is exactly `baseAssetId/quoteAssetId`; nothing else derives one. */
export function instrumentIdOf(instrument: Instrument): string {
  return `${instrument.baseAssetId}/${instrument.quoteAssetId}`;
}

/**
 * A band bound or a price target as the gate takes it, or `null` when the
 * stored text is not one.
 *
 * Parsed against `@vigil/contracts`' decimal schema rather than asserted
 * into the branded type, and then held to being non-negative on top of it —
 * `decimalStringSchema` admits a leading `-`, and a band bound, an entry
 * price and an exit target are none of them ever negative. That is the same
 * rule `position_plans_prices_decimal` enforces in SQL, restated here so
 * this check stays a superset of the column's rather than a subset: a
 * negative that reached the band would widen it below what was approved.
 */
function priceOf(value: string): DecimalString | null {
  const parsed = decimalStringSchema.safeParse(value);
  return parsed.success && !value.startsWith("-") ? parsed.data : null;
}

/**
 * The terms this dispatch is revalidated against, or the reason they cannot
 * be used.
 *
 * A price that fails `priceOf` means the SQL and the application have
 * drifted apart, since the column's own check refuses an exponent, a
 * negative, and a `NaN` alike — which is exactly when a cast past the
 * branded type would be worst, because it would hand a malformed price to
 * the arithmetic that decides whether to spend.
 */
export function planTermsFor(plan: StoredPositionPlan, instrument: Instrument, intentId: string): PositionPlanTermsResult {
  const expectedInstrumentId = instrumentIdOf(instrument);
  if (plan.instrumentId !== expectedInstrumentId) {
    return {
      outcome: "refused",
      refusal: executionRefusal(
        "POSITION_PLAN_UNUSABLE",
        `position plan ${plan.positionPlanId} states terms for "${plan.instrumentId}" but intent ${intentId} is being dispatched against "${expectedInstrumentId}"; another instrument's entry zone and exit target never price this one`,
      ),
    };
  }

  const min = priceOf(plan.entryZoneMin);
  const max = priceOf(plan.entryZoneMax);
  const exit = priceOf(plan.thesisExitPrice);
  if (min === null || max === null || exit === null) {
    const unreadable = [
      min === null ? `entryZoneMin "${plan.entryZoneMin}"` : null,
      max === null ? `entryZoneMax "${plan.entryZoneMax}"` : null,
      exit === null ? `thesisExitPrice "${plan.thesisExitPrice}"` : null,
    ]
      .filter((named): named is string => named !== null)
      .join(", ");
    return {
      outcome: "refused",
      refusal: executionRefusal(
        "POSITION_PLAN_UNUSABLE",
        `position plan ${plan.positionPlanId} carries ${unreadable}, which is not a non-negative decimal string this build can price intent ${intentId} against`,
      ),
    };
  }

  return {
    outcome: "terms",
    terms: {
      entryZone: { min, max },
      thesis: { expectedExitPriceQuote: exit },
    },
  };
}
