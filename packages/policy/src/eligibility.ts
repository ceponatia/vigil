import { z } from "zod";
import { ageMs, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { policyConfigSchema, refusalForParseError, scaleBoundedDecimalSchema } from "./config";
import { negativeCostComponent, netEdgeCostsSchema } from "./costs";
import { inputRefusal, policyRefusal, type PolicyRefusal } from "./diagnostics";
import { addDecimal, compareDecimal, isDecomposable, isNegative, isPositive, multiplyDecimal, subtractDecimal } from "./scaled-decimal";

/**
 * eligibility.ts — the five checks that stand between a proposal and a
 * reservation of real capital, each raising one `docs/policy.md` reason
 * code from `packages/contracts`' registry.
 *
 * | Check | Code |
 * | --- | --- |
 * | `checkAccountReconciled` | `ACCOUNT_UNRECONCILED` |
 * | `checkQuoteFreshness` | `STALE_QUOTE` |
 * | `checkEntryZone` | `OUTSIDE_ENTRY_ZONE` |
 * | `checkExposure` | `EXPOSURE_LIMIT` |
 * | `checkNetEdge` | `INSUFFICIENT_NET_EDGE` |
 *
 * Each is a pure function of its arguments — no IO, no clock read (`now`
 * is injected), no randomness — and each returns a reason-coded result
 * rather than throwing (`docs/resilience.md` §4). Each also re-parses its
 * own parameters, including the `PolicyConfig` it is handed
 * (`docs/resilience.md` §5): the branded/inferred types are compile-time
 * guarantees a cast can bypass, and every one of these functions sits on
 * the money path, so a bypassed type fails closed as a diagnostic instead
 * of reaching the arithmetic.
 *
 * ## Boundary convention
 *
 * Every threshold in this file is inclusive of its own boundary — a quote
 * exactly at `maxQuoteAgeMs` is still fresh, a price exactly at
 * `entryZone.max` is still inside the zone, net edge exactly at
 * `minimumNetEdgeQuote` still clears it. That follows both
 * `docs/policy.md`'s own "at most X" phrasing for its controls and the
 * precedent `packages/market/src/freshness.ts` already set ("only an age
 * strictly greater than `maxAgeMs` is stale"). One convention, stated
 * once, tested at each boundary — the alternative is a per-check coin flip
 * nobody can audit.
 *
 * Exposure is the deliberate exception, and not really an exception at
 * all: the cap bounds *resulting* exposure, so a cap already met leaves
 * zero headroom and any new position breaches it. See `checkExposure`.
 */

/** The uniform shape of a check that has nothing to report beyond pass/fail. */
export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly refusal: PolicyRefusal };

const refuse = (refusal: PolicyRefusal): { readonly eligible: false; readonly refusal: PolicyRefusal } => ({
  eligible: false,
  refusal,
});

const ELIGIBLE: { readonly eligible: true } = { eligible: true };

// ---------------------------------------------------------------------------
// ACCOUNT_UNRECONCILED
// ---------------------------------------------------------------------------

/**
 * What is known about the account's agreement with the ledger. Supplied by
 * the caller (`apps/trading`, reading `packages/ledger`/`packages/db`);
 * this package neither queries nor caches it.
 *
 * `reconciledThrough` is nullable rather than optional so "never
 * reconciled" is a value a caller must state, not a field they can forget.
 * Under `exactOptionalPropertyTypes` an omitted optional and an explicit
 * `undefined` are already distinct; making it required and nullable
 * removes the third state entirely.
 */
export const reconciliationStateSchema = z.strictObject({
  /** When reconciliation last completed against the venue's or chain's own confirmed state. `null` means it never has. */
  reconciledThrough: isoUtcTimestampSchema.nullable(),
  /** Differences found and not yet resolved. Any at all blocks new risk. */
  unresolvedDiscrepancyCount: z.number().int().min(0),
});

export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;

const accountReconciledParamsSchema = z.strictObject({
  state: reconciliationStateSchema,
  now: isoUtcTimestampSchema,
  config: policyConfigSchema,
});

export type CheckAccountReconciledParams = z.infer<typeof accountReconciledParamsSchema>;

/**
 * Blocks new risk on unreconciled balances (`docs/resilience.md` §1:
 * "Unreconciled balances, or a private-feed gap" is a fail-closed
 * condition).
 *
 * The bug class this is shaped against is treating absence of evidence as
 * evidence of reconciliation. Every branch here requires *positive*
 * evidence that reconciliation happened, recently enough, and found
 * nothing outstanding; anything else — never reconciled, an unresolved
 * discrepancy, an age that cannot be computed, a future-dated
 * reconciliation timestamp — refuses.
 *
 * A future-dated `reconciledThrough` is corrupt provenance, not an
 * unusually fresh reconciliation, and is refused for the same reason
 * `packages/market/src/freshness.ts` refuses a future-dated quote. Treating
 * it as fresh is precisely how a clock-skewed or fabricated timestamp would
 * unblock new risk indefinitely.
 */
export function checkAccountReconciled(params: CheckAccountReconciledParams): EligibilityResult {
  const parsed = accountReconciledParamsSchema.safeParse(params);
  if (!parsed.success) {
    return refuse(refusalForParseError(parsed.error));
  }
  const { state, now, config } = parsed.data;

  if (state.reconciledThrough === null) {
    return refuse(
      policyRefusal(
        "ACCOUNT_UNRECONCILED",
        "balances have never been reconciled against the ledger; new risk is blocked until a known-good state exists",
      ),
    );
  }

  if (state.unresolvedDiscrepancyCount > 0) {
    return refuse(
      policyRefusal(
        "ACCOUNT_UNRECONCILED",
        `${String(state.unresolvedDiscrepancyCount)} reconciliation discrepancy/discrepancies are unresolved; new risk is blocked until they are`,
      ),
    );
  }

  const reconciliationAgeMs = ageMs(state.reconciledThrough, now);

  if (Number.isNaN(reconciliationAgeMs)) {
    return refuse(
      inputRefusal(
        "UNCOMPUTABLE_AGE",
        'reconciliation age could not be computed — "now" or "reconciledThrough" did not resolve to a valid instant',
      ),
    );
  }

  if (reconciliationAgeMs < 0) {
    return refuse(
      policyRefusal(
        "ACCOUNT_UNRECONCILED",
        `reconciliation is dated ${String(-reconciliationAgeMs)}ms after "now"; a future-dated reconciliation is corrupt provenance, never an unusually fresh one`,
      ),
    );
  }

  if (reconciliationAgeMs > config.maxReconciliationAgeMs) {
    return refuse(
      policyRefusal(
        "ACCOUNT_UNRECONCILED",
        `last reconciliation is ${String(reconciliationAgeMs)}ms old, exceeding the configured ${String(config.maxReconciliationAgeMs)}ms`,
      ),
    );
  }

  return ELIGIBLE;
}

// ---------------------------------------------------------------------------
// STALE_QUOTE
// ---------------------------------------------------------------------------

const quoteFreshnessParamsSchema = z.strictObject({
  quoteAcquiredAt: isoUtcTimestampSchema,
  now: isoUtcTimestampSchema,
  config: policyConfigSchema,
});

export type CheckQuoteFreshnessParams = z.infer<typeof quoteFreshnessParamsSchema>;

export type QuoteFreshnessResult =
  | { readonly eligible: true; readonly ageMs: number }
  | { readonly eligible: false; readonly refusal: PolicyRefusal };

/**
 * The allocator's own staleness gate. Reuses the *concept* of
 * `packages/market/src/freshness.ts`'s `evaluateQuoteFreshness`, not its
 * code: `packages/policy` may not import `@vigil/market`
 * (`docs/architecture.md` "Layer graph and import rules"), so the
 * acquisition time and "now" arrive as injected parameters and no clock is
 * read here.
 *
 * This is deliberately a second gate rather than a duplicate one. The
 * market package decides whether a snapshot is usable *as market data*; the
 * allocator decides whether it is fresh enough to *commit capital against*,
 * under its own injected `maxQuoteAgeMs`, at the moment of sizing rather
 * than the moment of parsing. A quote that was fresh when a candidate was
 * generated can be stale by the time it reaches a reservation.
 */
export function checkQuoteFreshness(params: CheckQuoteFreshnessParams): QuoteFreshnessResult {
  const parsed = quoteFreshnessParamsSchema.safeParse(params);
  if (!parsed.success) {
    return refuse(refusalForParseError(parsed.error));
  }
  const { quoteAcquiredAt, now, config } = parsed.data;

  const observedAgeMs = ageMs(quoteAcquiredAt, now);

  if (Number.isNaN(observedAgeMs)) {
    return refuse(
      inputRefusal(
        "UNCOMPUTABLE_AGE",
        'quote age could not be computed — "now" or "quoteAcquiredAt" did not resolve to a valid instant',
      ),
    );
  }

  if (observedAgeMs < 0) {
    return refuse(
      policyRefusal(
        "STALE_QUOTE",
        `quote is dated ${String(-observedAgeMs)}ms after "now"; a future-dated quote is treated as corrupt input, never as unusually fresh`,
      ),
    );
  }

  if (observedAgeMs > config.maxQuoteAgeMs) {
    return refuse(
      policyRefusal(
        "STALE_QUOTE",
        `quote is ${String(observedAgeMs)}ms old, exceeding the configured ${String(config.maxQuoteAgeMs)}ms freshness threshold`,
      ),
    );
  }

  return { eligible: true, ageMs: observedAgeMs };
}

// ---------------------------------------------------------------------------
// OUTSIDE_ENTRY_ZONE
// ---------------------------------------------------------------------------

/** The approved entry zone a proposal already carries. This package never derives one. */
export const entryZoneSchema = z
  .strictObject({
    min: scaleBoundedDecimalSchema,
    max: scaleBoundedDecimalSchema,
  })
  .refine(
    (zone) =>
      // `compareDecimal` is arithmetic, not trust-boundary-safe, and in
      // Zod 4 this object-level refine runs even when `min` or `max` failed
      // its own string check — verified against zod 4.6.2, not assumed.
      // So the ordering question is only asked once both sides are actually
      // decomposable. Answering `true` when one is not is correct: that
      // field's own error already rejects the object, and a second issue
      // claiming "min must be <= max" about a non-number would only
      // mislead whoever reads the refusal detail.
      !isDecomposable(zone.min) || !isDecomposable(zone.max) || compareDecimal(zone.min, zone.max) <= 0,
    { error: "entry zone min must be <= max" },
  );

export type EntryZone = z.infer<typeof entryZoneSchema>;

const entryZoneParamsSchema = z.strictObject({
  executablePrice: scaleBoundedDecimalSchema,
  entryZone: entryZoneSchema,
});

export type CheckEntryZoneParams = z.infer<typeof entryZoneParamsSchema>;

/**
 * Classifies the current executable price against the proposal's
 * already-approved entry zone. Like
 * `packages/strategies/src/no-chasing.ts`, no branch of this function ever
 * computes a new zone from the price — it only reads the zone it was given.
 *
 * Deliberately narrower than `no-chasing.ts`: that check admits an
 * `allowedExtension` above the zone so a strategy can distinguish WAIT from
 * MISSED. This one does not, and must not. The allocator is the last gate
 * before capital is reserved, and admitting a price above the approved zone
 * *here* is chasing — the exact behavior `docs/product.md`'s action
 * vocabulary forbids, arriving through the one component whose "yes" spends
 * money. A strategy may keep waiting outside the zone; the allocator says
 * no.
 */
export function checkEntryZone(params: CheckEntryZoneParams): EligibilityResult {
  const parsed = entryZoneParamsSchema.safeParse(params);
  if (!parsed.success) {
    return refuse(refusalForParseError(parsed.error));
  }
  const { executablePrice, entryZone } = parsed.data;

  if (compareDecimal(executablePrice, entryZone.min) < 0) {
    return refuse(
      policyRefusal(
        "OUTSIDE_ENTRY_ZONE",
        `executable price ${executablePrice} is below the approved entry zone [${entryZone.min}, ${entryZone.max}]`,
      ),
    );
  }

  if (compareDecimal(executablePrice, entryZone.max) > 0) {
    return refuse(
      policyRefusal(
        "OUTSIDE_ENTRY_ZONE",
        `executable price ${executablePrice} is above the approved entry zone [${entryZone.min}, ${entryZone.max}]; the allocator never extends a zone to reach a moved price`,
      ),
    );
  }

  return ELIGIBLE;
}

// ---------------------------------------------------------------------------
// EXPOSURE_LIMIT
// ---------------------------------------------------------------------------

export const EXPOSURE_SCOPES = ["asset", "sector", "portfolio"] as const;
export type ExposureScope = (typeof EXPOSURE_SCOPES)[number];

/**
 * One cap and the exposure already standing against it, both in quote
 * currency. `docs/policy.md`'s `EXPOSURE_LIMIT` covers "a single-asset,
 * sector, or portfolio exposure cap", so a caller supplies one entry per
 * cap that applies and this check evaluates all of them.
 */
export const exposureCapSchema = z.strictObject({
  scope: z.enum(EXPOSURE_SCOPES),
  /** Operator-facing name for the cap, e.g. the asset id or sector name. Never a credential or address. */
  label: z.string().min(1),
  /** Exposure already committed against this cap, including reserved-but-unfilled capital. */
  currentExposureQuote: scaleBoundedDecimalSchema,
  /** The cap itself, as an absolute quote-currency amount the caller derived from the owner's approved policy. */
  capQuote: scaleBoundedDecimalSchema,
});

export type ExposureCap = z.infer<typeof exposureCapSchema>;

const exposureParamsSchema = z.strictObject({
  caps: z.array(exposureCapSchema),
});

export type CheckExposureParams = z.infer<typeof exposureParamsSchema>;

export type ExposureResult =
  | {
      readonly eligible: true;
      /** The smallest headroom across every supplied cap — the amount `sizing.ts` takes as its exposure bound. */
      readonly headroomQuote: DecimalString;
      /** Which cap produced that headroom, so the allocator can say which limit is actually binding. */
      readonly bindingCap: ExposureCap;
    }
  | { readonly eligible: false; readonly refusal: PolicyRefusal };

/**
 * Refuses when any supplied cap has no headroom left, and otherwise reports
 * the smallest headroom so sizing can bound against it.
 *
 * Two fail-open modes this is shaped against, both of which look like
 * working code:
 *
 * 1. **Comparing current exposure to the cap and stopping there.** A check
 *    that only asks "are we already over?" passes every action that *takes*
 *    us over. The cap bounds resulting exposure, so headroom — not the
 *    current level — is the quantity that matters, and it is returned here
 *    precisely so `sizing.ts` cannot forget to apply it.
 * 2. **An empty cap set.** Folding `caps` with a "smallest so far" seeded at
 *    infinity — or reducing an empty array at all — silently means "no
 *    limit applies". `NO_EXPOSURE_CAP` refuses it instead: sizing against no
 *    cap is not the same as sizing against a generous one.
 *
 * Zero headroom refuses. A cap is "at most X" (`docs/policy.md`'s numerical
 * controls are all phrased that way), so exposure sitting exactly at the cap
 * is legal to *hold* and leaves nothing to *add*.
 */
export function checkExposure(params: CheckExposureParams): ExposureResult {
  const parsed = exposureParamsSchema.safeParse(params);
  if (!parsed.success) {
    return refuse(refusalForParseError(parsed.error));
  }
  const { caps } = parsed.data;

  if (caps.length === 0) {
    return refuse(
      inputRefusal(
        "NO_EXPOSURE_CAP",
        "no exposure cap was supplied; sizing against an empty cap set is sizing against no limit at all",
      ),
    );
  }

  let smallest: { readonly cap: ExposureCap; readonly headroomQuote: DecimalString } | null = null;

  for (const cap of caps) {
    if (isNegative(cap.currentExposureQuote) || isNegative(cap.capQuote)) {
      return refuse(
        inputRefusal(
          "MALFORMED_INPUT",
          `exposure cap "${cap.label}" (${cap.scope}) carries a negative current exposure or cap; both are absolute quote-currency amounts`,
        ),
      );
    }

    const headroomQuote = subtractDecimal(cap.capQuote, cap.currentExposureQuote);

    if (!isPositive(headroomQuote)) {
      return refuse(
        policyRefusal(
          "EXPOSURE_LIMIT",
          `${cap.scope} cap "${cap.label}" has no headroom: exposure ${cap.currentExposureQuote} against a cap of ${cap.capQuote}`,
        ),
      );
    }

    if (smallest === null || compareDecimal(headroomQuote, smallest.headroomQuote) < 0) {
      smallest = { cap, headroomQuote };
    }
  }

  if (smallest === null) {
    // Unreachable: `caps` is non-empty and every iteration either returns or
    // assigns. Kept as a refusal rather than a non-null assertion so the
    // impossible case still fails closed instead of throwing on the money path.
    return refuse(inputRefusal("NO_EXPOSURE_CAP", "no exposure cap produced a headroom value"));
  }

  return { eligible: true, headroomQuote: smallest.headroomQuote, bindingCap: smallest.cap };
}

// ---------------------------------------------------------------------------
// INSUFFICIENT_NET_EDGE
// ---------------------------------------------------------------------------


const netEdgeParamsSchema = z.strictObject({
  /** The sized quantity these costs are evaluated at. Costs are size-dependent, so net edge is too. */
  quantity: scaleBoundedDecimalSchema,
  executablePrice: scaleBoundedDecimalSchema,
  /** Expected favorable move per unit of base asset, before ANY cost, embedded or separately charged. */
  expectedGrossEdgePerUnitQuote: scaleBoundedDecimalSchema,
  costs: netEdgeCostsSchema,
  config: policyConfigSchema,
});

export type CheckNetEdgeParams = z.infer<typeof netEdgeParamsSchema>;

export type NetEdgeBreakdown = {
  readonly grossEdgeQuote: DecimalString;
  readonly notionalQuote: DecimalString;
  readonly proportionalFeeQuote: DecimalString;
  readonly spreadCostQuote: DecimalString;
  readonly slippageAllowanceQuote: DecimalString;
  readonly fixedCostsQuote: DecimalString;
  readonly totalCostQuote: DecimalString;
  readonly netEdgeQuote: DecimalString;
  readonly minimumNetEdgeQuote: DecimalString;
};

export type NetEdgeResult =
  | { readonly eligible: true; readonly breakdown: NetEdgeBreakdown }
  | { readonly eligible: false; readonly refusal: PolicyRefusal; readonly breakdown: NetEdgeBreakdown | null };

/**
 * Computes net edge from gross expected advantage minus every supplied cost
 * and compares it against the injected threshold.
 *
 * All arithmetic is exact: `multiplyDecimal` carries the sum of its
 * operands' scales, so no fee, spread, or notional is rounded on its way
 * into the comparison. Nothing here rounds *toward* eligibility.
 *
 * A negative cost component is refused outright rather than summed. It is
 * the one input that makes a proposal look better the more wrong it is — a
 * mis-signed rebate, or a venue field read with the wrong sign, would
 * inflate net edge past its threshold and authorize a trade that does not
 * clear it. The full breakdown is returned on both branches so an
 * opportunity-journal row can show which cost consumed the edge, not just
 * that it was consumed.
 */
export function checkNetEdge(params: CheckNetEdgeParams): NetEdgeResult {
  const parsed = netEdgeParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { ...refuse(refusalForParseError(parsed.error)), breakdown: null };
  }
  const { quantity, executablePrice, expectedGrossEdgePerUnitQuote, costs, config } = parsed.data;

  if (!isPositive(executablePrice)) {
    return {
      ...refuse(
        inputRefusal("NON_POSITIVE_PRICE", `executable price ${executablePrice} must be strictly positive to derive a notional`),
      ),
      breakdown: null,
    };
  }

  if (!isPositive(quantity)) {
    return {
      ...refuse(
        inputRefusal("MALFORMED_INPUT", `quantity ${quantity} must be strictly positive; net edge is evaluated at a real size`),
      ),
      breakdown: null,
    };
  }

  const negativeCost = negativeCostComponent(costs);

  if (negativeCost !== undefined) {
    return {
      ...refuse(
        inputRefusal(
          "NEGATIVE_COST_COMPONENT",
          `cost component "${negativeCost[0]}" is ${negativeCost[1]}; a negative cost would inflate net edge rather than reduce it`,
        ),
      ),
      breakdown: null,
    };
  }

  const notionalQuote = multiplyDecimal(quantity, executablePrice);
  const grossEdgeQuote = multiplyDecimal(expectedGrossEdgePerUnitQuote, quantity);
  const proportionalFeeQuote = multiplyDecimal(notionalQuote, costs.separatelyCharged.proportionalFeeRate);
  const spreadCostQuote = multiplyDecimal(costs.embedded.spreadCostPerUnitQuote, quantity);
  const slippageAllowanceQuote = multiplyDecimal(costs.separatelyCharged.slippageAllowancePerUnitQuote, quantity);
  const fixedCostsQuote = costs.separatelyCharged.fixedCostsQuote;

  // Net edge subtracts BOTH groups, unlike the sizing bounds, which subtract
  // only `separatelyCharged`. `expectedGrossEdgePerUnitQuote` is the move
  // before any cost at all, so an embedded cost reduces edge exactly once
  // here while correctly staying out of the capital bound (see `costs.ts`).
  const totalCostQuote = [spreadCostQuote, slippageAllowanceQuote, fixedCostsQuote].reduce(
    (total, component) => addDecimal(total, component),
    proportionalFeeQuote,
  );

  const netEdgeQuote = subtractDecimal(grossEdgeQuote, totalCostQuote);

  const breakdown: NetEdgeBreakdown = {
    grossEdgeQuote,
    notionalQuote,
    proportionalFeeQuote,
    spreadCostQuote,
    slippageAllowanceQuote,
    fixedCostsQuote,
    totalCostQuote,
    netEdgeQuote,
    minimumNetEdgeQuote: config.minimumNetEdgeQuote,
  };

  if (compareDecimal(netEdgeQuote, config.minimumNetEdgeQuote) < 0) {
    return {
      ...refuse(
        policyRefusal(
          "INSUFFICIENT_NET_EDGE",
          `net edge ${netEdgeQuote} (gross ${grossEdgeQuote} less costs ${totalCostQuote}) does not reach the configured minimum ${config.minimumNetEdgeQuote}`,
        ),
      ),
      breakdown,
    };
  }

  return { eligible: true, breakdown };
}
