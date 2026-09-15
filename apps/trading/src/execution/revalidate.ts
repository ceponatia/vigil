import type { AssetId, DecimalString, IsoUtcTimestamp } from "@vigil/contracts";
import type { OrderSide } from "@vigil/adapter-paper";
import { evaluateQuoteFreshness } from "@vigil/market";
import type { QuoteSnapshot } from "@vigil/market";
import {
  checkAccountReconciled,
  checkEntryZone,
  checkExposure,
  checkNetEdge,
  checkQuoteFreshness,
} from "@vigil/policy";
import type {
  EntryZone,
  ExposureCap,
  NetEdgeBreakdown,
  NetEdgeCosts,
  PolicyConfig,
  ReconciliationState,
} from "@vigil/policy";

import { executionRefusal, fromPolicyRefusal, policyBlock, type ExecutionRefusal } from "./diagnostics";
import type { VenueExecutionConfig } from "./venue";
import {
  decimalAt,
  envelopeFor,
  netEdgeCostsFor,
  priceExecutable,
  unitsAt,
  type ExecutionEnvelope,
  type VenuePricingView,
} from "./venue-economics";

/**
 * revalidate.ts — the gate immediately before every dispatch.
 *
 * **The candidate having once been attractive is not sufficient.** An
 * approved intent says an action was worth taking at the price and costs
 * that stood when policy approved it. By the time a payload is handed to a
 * venue, the book has moved, the spread has widened, or the fee snapshot has
 * changed, and the question "is this still worth doing" has a different
 * answer that nothing has asked. This module asks it, at the freshest
 * executable quote, at the quantity the authorization actually names.
 *
 * ## What is recomputed, and from what
 *
 * Everything. Nothing here reads a number the approval computed:
 *
 * - **the price** is the current executable side — the ask for a buy, the
 *   bid for a sell — moved by the venue's slippage cap, never a last-trade
 *   price and never the candidate's discovery price;
 * - **every cost** is derived from that quote and the injected fee snapshot:
 *   spread, slippage, the proportional venue fee, and the fixture's fixed
 *   cost (`venue-economics.ts` owns the arithmetic and the embedded /
 *   separately-charged translation that keeps each one counted exactly once);
 * - **gross edge** is `expectedExitPriceQuote` measured against the FRESH
 *   midpoint, not a per-unit figure carried forward. That is structural
 *   rather than stylistic: a frozen per-unit edge is the discovery-time
 *   number, and an intent whose edge has been eaten by a favourable move
 *   would still clear its hurdle with one. Because the exit price is fixed
 *   by the thesis and the midpoint is not, a mid that rises toward the
 *   target shrinks the gross edge exactly as it should.
 *
 * ## Why this is not `evaluateProposal`
 *
 * `evaluateProposal` composes the gates **and sizes the trade**, which is
 * what an approval needs and what `authorize.ts` calls it for. At dispatch
 * the quantity is not open: an approved intent is immutable, and the only
 * question is whether the quantity it already authorizes still clears every
 * gate. Re-sizing here would answer a question about a different trade.
 *
 * So the stages below are `EVALUATION_STAGES` with `sizing` removed and the
 * trust boundary added in front, in the same order and for the same reasons
 * (`@vigil/policy`'s `evaluate.ts`): state integrity, then market-state
 * integrity, then the approved zone, then the caps, then — last, because
 * costs are size-dependent — net edge at the authorized quantity.
 *
 * The first failing stage wins. There is no "collect every failure" mode:
 * evaluating a later gate against state an earlier one just declared
 * untrustworthy produces a misleading diagnostic, and a dispatch blocked for
 * any reason is blocked.
 */

export const REVALIDATION_STAGES = [
  /** The quote parses, is not corrupt, and is inside the intent's own freshness window. */
  "quote",
  /** The quote prices this intent's asset pair and not another instrument. */
  "instrument",
  /** The venue can hold the quoted prices, and the book is not crossed. */
  "pricing",
  /** Balances agree with the ledger recently enough to commit capital against. */
  "reconciliation",
  /** The quote is fresh enough under the allocator's own threshold, which may be tighter than the intent's. */
  "quoteFreshness",
  /** The price this dispatch would actually pay is inside the approved entry zone. */
  "entryZone",
  /** No supplied cap has run out of headroom. */
  "exposure",
  /** Expected advantage after every cost still clears the configured minimum. */
  "netEdge",
] as const;

export type RevalidationStage = (typeof REVALIDATION_STAGES)[number];

/**
 * The execution-relevant facts of an approved intent. Deliberately narrower
 * than the stored record: this module decides nothing about provenance,
 * funding, or protection, and a shape that carried them would invite it to.
 */
export type ExecutableIntent = {
  readonly intentId: string;
  readonly side: OrderSide;
  /** The instrument's base asset — what a buy acquires. */
  readonly baseAssetId: AssetId;
  /** The instrument's quote asset, and the numeraire every figure below is in. */
  readonly quoteAssetId: AssetId;
  /** The authorized quantity, in base-asset units at the venue's quantity scale. */
  readonly quantityUnits: bigint;
  readonly entryZone: EntryZone;
  /** How old the market data behind a dispatch may be, as the authorization set it. */
  readonly requiredFreshnessMs: number;
};

/**
 * The thesis figure gross edge is measured against.
 *
 * It is an input here because this module is pure: it reads no database and
 * no clock. The value is durable all the same — `position_plans` stores it
 * as `thesis_exit_price`, under the id the intent names through
 * `position_plan_id`, and `dispatch.ts` reads it back with
 * `loadPositionPlan` before calling this function. There is no field on
 * `DispatchRequest` for it, so a caller cannot supply a different one, and a
 * process that restarted since the approval reaches exactly the same figure
 * as the process that approved it.
 *
 * What is stored is the **exit price**, never the per-unit edge the approval
 * computed from it. `approved_intents.expected_gross_base` is that edge at
 * the approval's own midpoint, and reading it back here instead would clear
 * this intent's hurdle forever however far the market had since moved. The
 * exit target is fixed by the thesis; the midpoint is not; measuring one
 * against a fresh reading of the other is what makes a decayed edge fail.
 */
export type ThesisTarget = {
  /**
   * The price the thesis expects this position to be worth: the exit target
   * for a buy, the level being exited toward for a sell. Gross edge per unit
   * is `exitPrice - mid` for a buy and `mid - exitPrice` for a sell, and is
   * deliberately NOT floored at zero — a target the market has already
   * passed produces a negative edge, which is exactly what must fail the
   * hurdle rather than be clamped into a pass.
   */
  readonly expectedExitPriceQuote: DecimalString;
};

/** The portfolio state the gates are judged against, read by the caller and never by this module. */
export type PortfolioState = {
  readonly account: ReconciliationState;
  /** One entry per cap that applies. An empty list is refused, never read as unlimited. */
  readonly exposureCaps: readonly ExposureCap[];
};

export type RevalidationRequest = {
  readonly intent: ExecutableIntent;
  readonly thesis: ThesisTarget;
  /** Untrusted: parsed against `@vigil/market`'s own schema before anything reads it. */
  readonly quote: unknown;
  readonly now: IsoUtcTimestamp;
  readonly venue: VenueExecutionConfig;
  readonly policyConfig: PolicyConfig;
  readonly portfolio: PortfolioState;
};

/**
 * Proof that a dispatch was revalidated, and the numbers it was cleared on.
 *
 * `dispatchAttempt` takes one of these rather than a quote, so "every
 * dispatch path runs a fresh pre-dispatch check" is a type-level fact and
 * not a convention — there is no way to reach `submitOrder` in this
 * application without having produced one first.
 */
export type DispatchClearance = {
  readonly outcome: "cleared";
  readonly quote: QuoteSnapshot;
  readonly quoteAgeMs: number;
  readonly pricing: VenuePricingView;
  readonly costs: NetEdgeCosts;
  readonly expectedGrossEdgePerUnitQuote: DecimalString;
  readonly netEdge: NetEdgeBreakdown;
  readonly envelope: ExecutionEnvelope;
  readonly clearedAt: IsoUtcTimestamp;
};

export type DispatchBlocked = {
  readonly outcome: "blocked";
  readonly stage: RevalidationStage;
  readonly refusal: ExecutionRefusal;
  /** The arithmetic that failed, when the net-edge stage is what refused; `null` on every earlier stage. */
  readonly netEdge: NetEdgeBreakdown | null;
  /** What the venue would have charged, when pricing got that far. */
  readonly pricing: VenuePricingView | null;
  /**
   * When the quote this refusal was judged against was acquired, or `null`
   * when no quote parsed. Carried so a skip can be journaled with the age of
   * the data behind it — `docs/evaluation.md`'s point-in-time integrity is
   * not reconstructable after the fact, and "we skipped" without "on what,
   * and how fresh" is the half of an opportunity-journal row that cannot be
   * analysed later.
   */
  readonly quoteAcquiredAt: IsoUtcTimestamp | null;
  readonly blockedAt: IsoUtcTimestamp;
};

export type RevalidationResult = DispatchClearance | DispatchBlocked;

function blocked(
  stage: RevalidationStage,
  refusal: ExecutionRefusal,
  now: IsoUtcTimestamp,
  detail: {
    readonly netEdge?: NetEdgeBreakdown | null;
    readonly pricing?: VenuePricingView | null;
    readonly quoteAcquiredAt?: IsoUtcTimestamp | null;
  } = {},
): DispatchBlocked {
  return {
    outcome: "blocked",
    stage,
    refusal,
    netEdge: detail.netEdge ?? null,
    pricing: detail.pricing ?? null,
    quoteAcquiredAt: detail.quoteAcquiredAt ?? null,
    blockedAt: now,
  };
}

/**
 * Runs every gate against a fresh quote and returns either a clearance
 * carrying the numbers it cleared on, or the first refusal with the stage
 * that produced it. Pure and deterministic: no clock read (`now` is
 * injected), no IO, and never throwing on schema-legal input.
 */
export function revalidateBeforeDispatch(request: RevalidationRequest): RevalidationResult {
  const { intent, thesis, now, venue, policyConfig, portfolio } = request;

  // ---- trust boundary -----------------------------------------------------
  // The intent's own freshness window, not the allocator's: the
  // authorization stated how old the data behind an attempt may be, and a
  // quote outside that window cannot act on it whatever the allocator would
  // accept. The allocator's threshold runs as its own gate below.
  const evaluated = evaluateQuoteFreshness({ raw: request.quote, now, maxAgeMs: intent.requiredFreshnessMs });
  if (!evaluated.executable) {
    return blocked("quote", policyBlock(evaluated.reasonCode, evaluated.detail), now);
  }
  const quote = evaluated.quote;
  const acquiredAt = quote.timestamps.quoteAcquiredAt;

  // Schema and freshness say the quote is well-formed and current; neither
  // says it prices THIS intent's assets. An instrument id is exactly
  // `baseAssetId/quoteAssetId`, so the pair the intent names derives the id
  // its quote must carry (`docs/resilience.md` §5: identity is re-validated
  // after parsing). A quote for another instrument is not a policy judgement
  // about the proposal, so it carries no policy code.
  const expectedInstrumentId = `${intent.baseAssetId}/${intent.quoteAssetId}`;
  if (quote.instrumentId !== expectedInstrumentId) {
    return blocked(
      "instrument",
      executionRefusal(
        "QUOTE_INSTRUMENT_MISMATCH",
        `the quote prices "${quote.instrumentId}" but intent ${intent.intentId} trades "${expectedInstrumentId}"; a quote for another instrument never prices this intent`,
      ),
      now,
      { quoteAcquiredAt: acquiredAt },
    );
  }

  const priced = priceExecutable(intent.side, quote, venue);
  if (priced.outcome === "unpriceable") {
    return blocked("pricing", executionRefusal(priced.failure.reason, priced.failure.detail), now, {
      quoteAcquiredAt: acquiredAt,
    });
  }
  const pricing = priced.pricing;

  // ---- the policy gates, in `EVALUATION_STAGES` order ---------------------
  const reconciliation = checkAccountReconciled({ state: portfolio.account, now, config: policyConfig });
  if (!reconciliation.eligible) {
    return blocked("reconciliation", fromPolicyRefusal(reconciliation.refusal), now, {
      pricing,
      quoteAcquiredAt: acquiredAt,
    });
  }

  const freshness = checkQuoteFreshness({
    quoteAcquiredAt: quote.timestamps.quoteAcquiredAt,
    now,
    config: policyConfig,
  });
  if (!freshness.eligible) {
    return blocked("quoteFreshness", fromPolicyRefusal(freshness.refusal), now, {
      pricing,
      quoteAcquiredAt: acquiredAt,
    });
  }

  // Judged at the price this dispatch would actually pay, NOT at the ask.
  //
  // The entry zone is the band the proposal was approved to pay within, and
  // what is actually paid is `executionPrice` — the ask plus the spread and
  // the slippage cap already inside it. Gating on the ask would let slippage
  // carry a real fill outside the approved band while the gate reported
  // success, which is chasing: paying more than the plan allowed. The
  // allocator is the last gate before capital moves, so it judges the number
  // that leaves the account (owner ruling, confirmed on #35).
  const zone = checkEntryZone({ executablePrice: pricing.executionPrice, entryZone: intent.entryZone });
  if (!zone.eligible) {
    return blocked("entryZone", fromPolicyRefusal(zone.refusal), now, { pricing, quoteAcquiredAt: acquiredAt });
  }

  // A fresh array, because `CheckExposureParams.caps` is mutable and the
  // portfolio's list is readonly — the copy is the boundary, not a defensive
  // habit.
  const exposure = checkExposure({ caps: [...portfolio.exposureCaps] });
  if (!exposure.eligible) {
    return blocked("exposure", fromPolicyRefusal(exposure.refusal), now, { pricing, quoteAcquiredAt: acquiredAt });
  }

  // ---- net edge, at the authorized quantity -------------------------------
  const grossEdgeUnits = unitsBetween(thesis, pricing);
  if (grossEdgeUnits.unrepresentable) {
    return blocked(
      "pricing",
      executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the thesis exit price "${thesis.expectedExitPriceQuote}" carries finer precision than the venue's money scale (${String(venue.moneyScale)})`,
      ),
      now,
      { pricing, quoteAcquiredAt: acquiredAt },
    );
  }
  const expectedGrossEdgePerUnitQuote = decimalAt(grossEdgeUnits.perUnit, venue.moneyScale);

  const costs = netEdgeCostsFor(pricing);
  const quantity = decimalAt(intent.quantityUnits, venue.quantityScale);
  const netEdge = checkNetEdge({
    quantity,
    executablePrice: pricing.executionPrice,
    expectedGrossEdgePerUnitQuote,
    costs,
    config: policyConfig,
  });
  if (!netEdge.eligible) {
    return blocked("netEdge", fromPolicyRefusal(netEdge.refusal), now, {
      netEdge: netEdge.breakdown,
      pricing,
      quoteAcquiredAt: acquiredAt,
    });
  }

  return {
    outcome: "cleared",
    quote,
    quoteAgeMs: freshness.ageMs,
    pricing,
    costs,
    expectedGrossEdgePerUnitQuote,
    netEdge: netEdge.breakdown,
    envelope: envelopeFor(pricing, intent.quantityUnits),
    clearedAt: now,
  };
}

/**
 * Gross edge per unit, measured from the FRESH midpoint.
 *
 * Signed on purpose. A buy whose midpoint has already risen past the thesis
 * target has negative gross edge, and reporting it as such is what makes
 * `checkNetEdge` refuse rather than approve a trade with nothing left in it.
 *
 * An exit price the venue's own money scale cannot hold is reported rather
 * than rounded: rounding it toward vigil would manufacture edge, and
 * rounding it away would refuse a target that is merely written at a finer
 * precision than the venue quotes.
 */
function unitsBetween(
  thesis: ThesisTarget,
  pricing: VenuePricingView,
): { readonly perUnit: bigint; readonly unrepresentable: boolean } {
  const exitUnits = exitPriceUnits(thesis, pricing);
  if (exitUnits === null) {
    return { perUnit: 0n, unrepresentable: true };
  }
  const mid = pricing.units.referenceMid;
  return { perUnit: pricing.side === "BUY" ? exitUnits - mid : mid - exitUnits, unrepresentable: false };
}

function exitPriceUnits(thesis: ThesisTarget, pricing: VenuePricingView): bigint | null {
  return unitsAt(thesis.expectedExitPriceQuote, pricing.moneyScale);
}
