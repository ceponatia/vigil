import { z } from "zod";
import { decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { policyConfigSchema, refusalForParseError } from "./config";
import type { PolicyRefusal } from "./diagnostics";
import {
  checkAccountReconciled,
  checkEntryZone,
  checkExposure,
  checkNetEdge,
  checkQuoteFreshness,
  entryZoneSchema,
  exposureCapSchema,
  netEdgeCostsSchema,
  reconciliationStateSchema,
  type ExposureCap,
  type NetEdgeBreakdown,
} from "./eligibility";
import { sizeTrade, type SizedTrade } from "./sizing";

/**
 * evaluate.ts — the composed gate: every eligibility check and the sizing
 * rule, run in one fail-closed order, as the single call `apps/trading`
 * makes before reserving capital.
 *
 * This exists because ordering is itself a safety property, and a property
 * spread across call sites is one nobody tests. The individual checks in
 * `eligibility.ts` and `sizing.ts` stay exported — a caller with a genuine
 * reason to ask one question in isolation can — but the composed path is
 * the one that cannot forget a gate. A `sizeTrade` called without
 * `checkAccountReconciled` is a sized trade on balances that may not
 * reconcile, and nothing in `sizing.ts` would notice.
 *
 * ## Order, and why this order
 *
 * 1. `reconciliation` → `ACCOUNT_UNRECONCILED`. State integrity first: if
 *    the balances are not trustworthy, no downstream number computed from
 *    them is either, and `docs/resilience.md` §1 blocks new risk on
 *    unreconciled balances regardless of how attractive the proposal is.
 * 2. `quoteFreshness` → `STALE_QUOTE`. Market-state integrity next, for the
 *    same reason: the price everything else is computed against must be
 *    current before it is worth computing anything against it.
 * 3. `entryZone` → `OUTSIDE_ENTRY_ZONE`. Now that the price is trustworthy,
 *    is it a price this proposal approved?
 * 4. `exposure` → `EXPOSURE_LIMIT`. A cap with no headroom refuses here,
 *    rather than flowing into sizing as a zero bound. That distinction is
 *    the point: a zero-headroom cap that reached sizing would produce a
 *    `MINIMUM_NOTIONAL` skip, filing an exposure breach in the opportunity
 *    journal under the wrong reason code and hiding the breached cap's
 *    name. Same outcome for the money, materially worse for the operator.
 * 5. `sizing` → `MINIMUM_NOTIONAL`. Only now, against a trustworthy price
 *    and real headroom, is a size computed.
 * 6. `netEdge` → `INSUFFICIENT_NET_EDGE`. Deliberately last, and
 *    deliberately after sizing: costs are size-dependent (a proportional
 *    fee scales with notional, gas does not scale at all), so net edge is
 *    only meaningful once the quantity is known. Checking it against a
 *    hypothetical size would answer a question about a trade that is not
 *    the one being proposed.
 *
 * The first failing stage wins and the rest do not run — there is no
 * "collect every failure" mode, because a proposal refused for any reason
 * is refused, and evaluating later gates against state an earlier gate just
 * declared untrustworthy produces misleading diagnostics.
 */

export const EVALUATION_STAGES = [
  "reconciliation",
  "quoteFreshness",
  "entryZone",
  "exposure",
  "sizing",
  "netEdge",
] as const;

export type EvaluationStage = (typeof EVALUATION_STAGES)[number];

export const proposalEvaluationParamsSchema = z.strictObject({
  config: policyConfigSchema,
  /** Injected current time. This package reads no clock. */
  now: isoUtcTimestampSchema,
  account: reconciliationStateSchema,
  quote: z.strictObject({
    quoteAcquiredAt: isoUtcTimestampSchema,
    executablePrice: decimalStringSchema,
  }),
  entryZone: entryZoneSchema,
  /** One entry per cap that applies. An empty list is refused, not treated as unlimited. */
  exposureCaps: z.array(exposureCapSchema),
  capital: z.strictObject({
    fundsAvailableQuote: decimalStringSchema,
    executableLiquidityBase: decimalStringSchema,
    adverseLossBudgetQuote: decimalStringSchema,
    stopDistanceQuote: decimalStringSchema,
  }),
  edge: z.strictObject({
    expectedGrossEdgePerUnitQuote: decimalStringSchema,
    costs: netEdgeCostsSchema,
  }),
});

export type ProposalEvaluationParams = z.infer<typeof proposalEvaluationParamsSchema>;

/** What the approved path learned along the way, for the opportunity journal. */
export type ApprovedEvaluation = {
  readonly outcome: "approved";
  readonly size: SizedTrade;
  readonly netEdge: NetEdgeBreakdown;
  readonly quoteAgeMs: number;
  readonly exposureHeadroomQuote: DecimalString;
  readonly bindingExposureCap: ExposureCap;
};

export type RefusedEvaluation = {
  readonly outcome: "refused";
  /** Which gate refused. `null` only when the parameters themselves did not parse. */
  readonly stage: EvaluationStage | null;
  readonly refusal: PolicyRefusal;
};

export type ProposalEvaluation = ApprovedEvaluation | RefusedEvaluation;

const refusedAt = (stage: EvaluationStage | null, refusal: PolicyRefusal): RefusedEvaluation => ({
  outcome: "refused",
  stage,
  refusal,
});

/**
 * Runs every gate in the documented order and returns either an approved,
 * fully-explained size or the first refusal with the stage that produced
 * it. Pure, deterministic, and never throwing on schema-legal input.
 *
 * "Approved" here means eligible and sized — it is not itself a
 * reservation, an intent, or an order. `packages/ledger` owns reservations
 * and `packages/db` owns the approved-intent record; this package only ever
 * answers the question.
 */
export function evaluateProposal(params: ProposalEvaluationParams): ProposalEvaluation {
  const parsed = proposalEvaluationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return refusedAt(null, refusalForParseError(parsed.error));
  }
  const { config, now, account, quote, entryZone, exposureCaps, capital, edge } = parsed.data;

  const reconciliation = checkAccountReconciled({ state: account, now, config });
  if (!reconciliation.eligible) {
    return refusedAt("reconciliation", reconciliation.refusal);
  }

  const freshness = checkQuoteFreshness({ quoteAcquiredAt: quote.quoteAcquiredAt, now, config });
  if (!freshness.eligible) {
    return refusedAt("quoteFreshness", freshness.refusal);
  }

  const zone = checkEntryZone({ executablePrice: quote.executablePrice, entryZone });
  if (!zone.eligible) {
    return refusedAt("entryZone", zone.refusal);
  }

  const exposure = checkExposure({ caps: exposureCaps });
  if (!exposure.eligible) {
    return refusedAt("exposure", exposure.refusal);
  }

  const sized = sizeTrade({
    inputs: {
      fundsAvailableQuote: capital.fundsAvailableQuote,
      exposureHeadroomQuote: exposure.headroomQuote,
      executableLiquidityBase: capital.executableLiquidityBase,
      adverseLossBudgetQuote: capital.adverseLossBudgetQuote,
      stopDistanceQuote: capital.stopDistanceQuote,
      executablePrice: quote.executablePrice,
    },
    config,
  });
  if (sized.outcome === "refused") {
    return refusedAt("sizing", sized.refusal);
  }

  const netEdge = checkNetEdge({
    quantity: sized.size.quantityBase,
    executablePrice: quote.executablePrice,
    expectedGrossEdgePerUnitQuote: edge.expectedGrossEdgePerUnitQuote,
    costs: edge.costs,
    config,
  });
  if (!netEdge.eligible) {
    return refusedAt("netEdge", netEdge.refusal);
  }

  return {
    outcome: "approved",
    size: sized.size,
    netEdge: netEdge.breakdown,
    quoteAgeMs: freshness.ageMs,
    exposureHeadroomQuote: exposure.headroomQuote,
    bindingExposureCap: exposure.bindingCap,
  };
}
