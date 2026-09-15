import type { AssetId, DecimalString, IsoUtcTimestamp } from "@vigil/contracts";
import { ACTION_ORDER_SIDES } from "@vigil/adapter-paper";
import type { OrderSide, TradeAction } from "@vigil/adapter-paper";
import { recordApprovedIntent, recordPositionPlan } from "@vigil/db";
import type {
  CostChargeBasisValue,
  CostComponentKindValue,
  IntentCostComponent,
  StoreApprovedIntent,
  VigilDatabase,
} from "@vigil/db";
import type { QuoteSnapshot } from "@vigil/market";
import { evaluateProposal } from "@vigil/policy";
import type { ApprovedEvaluation, EntryZone, PolicyConfig } from "@vigil/policy";

import { executionRefusal, fromPolicyRefusal, policyBlock, type ExecutionRefusal } from "./diagnostics";
import type { PortfolioState, ThesisTarget } from "./revalidate";
import type { VenueExecutionConfig } from "./venue";
import {
  decimalAt,
  envelopeFor,
  netEdgeCostsFor,
  priceExecutable,
  scaleFactor,
  scaledProduct,
  unitsAt,
  type ExecutionEnvelope,
  type VenuePricingView,
} from "./venue-economics";

/**
 * authorize.ts — turning an evaluated proposal into the one durable record
 * that says money may move.
 *
 * This is the **approval-time** evaluation, and it is where
 * `evaluateProposal` belongs: the quantity is open, so the composed gate
 * that sizes as well as screens is the right call, and its documented
 * ordering is a safety property no call site here can forget. The
 * **dispatch-time** evaluation is `revalidate.ts`, which re-asks every gate
 * at a fresh quote and at the quantity this record fixed.
 *
 * Two properties of the record written here are what the rest of the slice
 * stands on:
 *
 * - **The same proposal delivered twice authorizes one spend.** That is the
 *   database's guarantee, not this function's: `approved_intents` carries a
 *   unique index on `idempotency_key` and another on `economic_action_id`,
 *   and `recordApprovedIntent` answers a redelivery with `duplicate` and the
 *   id of the authorization that already exists. This function's job is to
 *   hand that answer back honestly rather than reporting a second approval.
 * - **The economics that passed policy are stored with it.** `docs/evaluation.md`'s
 *   point-in-time integrity cannot be reconstructed afterwards — the quote
 *   and the fee snapshot that were true at approval are gone by the time the
 *   fill is judged — so the notional, the gross, every cost component and
 *   the hurdle go onto the row, and `intent_cost_components` records each
 *   cost under the basis the VENUE charges it on (spread and slippage
 *   `embedded`, the fee and the fixed cost `separately-charged`). A later
 *   comparison against a realized fill can then subtract the separately
 *   charged ones from a gross that already contains the embedded ones,
 *   without counting either twice.
 *
 * ## Why this writes a position plan before it writes the authorization
 *
 * The record above is the **result** of the approval. The **terms** it was
 * derived from — the entry zone this proposal may be filled within and the
 * exit price its gross edge is measured against — are not on it, and the
 * pre-dispatch gate needs both every time it runs. Held only in this
 * process's memory they would die with the process, and an `apps/trading`
 * that restarted between approval and dispatch could not revalidate an
 * intent it did not approve in the same run.
 *
 * So the terms go to `position_plans`, under the id the intent already
 * names, before the intent is written. The ordering is what makes the pair
 * safe in either direction of a crash: a plan with no authorization is inert
 * — nothing dispatches against a plan — while an authorization with no plan
 * is one the gate refuses outright (`UNKNOWN_POSITION_PLAN`), which this
 * ordering makes unreachable rather than merely unlikely.
 *
 * A plan is recorded once. A second proposal naming the same plan under
 * *different* terms is refused rather than written, and the authorization
 * with it: an intent approved against one entry zone and revalidated at
 * dispatch against another is approved by nothing.
 *
 * ## Entry actions only
 *
 * `BUY` and `ADD` are authorized here. `TRIM` and `EXIT` map to the sell
 * side, whose authorization needs a position basis and realized-P&L
 * accounting this build does not have, and `HOLD`/`WAIT`/`AVOID` authorize
 * no execution at all — a decision to do nothing is never turned into an
 * order. The arithmetic in `venue-economics.ts` is side-symmetric so the
 * exit slice inherits it; only the asset-side mapping and the accounting
 * are missing, and inventing them here would put an unverified basis
 * calculation on the money path.
 */

/** Everything a caller states about the action it wants authorized. */
export type TradeProposal = {
  readonly intentId: string;
  /** The same proposal delivered twice carries the same key and authorizes one spend. */
  readonly idempotencyKey: string;
  /** Threads this authorization to its candidate, holds, attempts, and postings (`docs/resilience.md` §10). */
  readonly correlationId: string;
  /** The economic action this is one authorization for; unique across every intent. */
  readonly economicActionId: string;
  readonly positionPlanId: string;
  /** The journaled candidate this came from; null for an action no candidate produced. */
  readonly candidateId: string | null;
  readonly fundingAccountId: string;
  readonly action: TradeAction;
  /** What a buy acquires. Its ledger scale must be the venue's quantity scale. */
  readonly baseAssetId: AssetId;
  /** What a buy spends, and the numeraire every economic figure is denominated in. */
  readonly quoteAssetId: AssetId;
  readonly entryZone: EntryZone;
  readonly thesis: ThesisTarget;
  /** The base-asset quantity below which this position is not worth holding. Stated, never invented. */
  readonly minAcceptableReceiptQuantity: DecimalString;
  /** Input-asset amount that may be left unspent without the action being incomplete. */
  readonly permittedResidualQuote: DecimalString;
  readonly validUntil: IsoUtcTimestamp;
  readonly requiredFreshnessMs: number;
  readonly protectionPlan: string | null;
  readonly remainingInventoryTreatment: string;
  readonly benchmarkId: string | null;
  readonly approvalReason: string | null;
  /** The quote or market snapshot this decision was made on. */
  readonly quoteId: string;
  readonly provenance: {
    readonly policyVersion: string;
    readonly strategyVersion: string;
    /** Null when no LLM was involved — every deterministic path today. */
    readonly modelVersion: string | null;
    readonly portfolioSnapshotVersion: string;
    readonly marketSnapshotVersion: string;
  };
};

/** The capital state the sizing bounds are solved against, read by the caller. */
export type CapitalState = {
  readonly fundsAvailableQuote: DecimalString;
  readonly adverseLossBudgetQuote: DecimalString;
  /** Quote-currency loss per unit if the stop is hit — measured from the execution price. */
  readonly stopDistanceQuote: DecimalString;
};

export type AuthorizeRequest = {
  readonly proposal: TradeProposal;
  /** Untrusted at the caller's boundary; already parsed by the time it reaches here. */
  readonly quote: QuoteSnapshot;
  readonly now: IsoUtcTimestamp;
  readonly operatingMode: string;
  readonly venue: VenueExecutionConfig;
  readonly policyConfig: PolicyConfig;
  readonly portfolio: PortfolioState;
  readonly capital: CapitalState;
};

export type AuthorizedIntent = {
  readonly outcome: "authorized";
  readonly intentId: string;
  /** True when this delivery found an authorization already standing under the same key. */
  readonly duplicate: boolean;
  readonly side: OrderSide;
  readonly quantityUnits: bigint;
  readonly evaluation: ApprovedEvaluation;
  readonly pricing: VenuePricingView;
  readonly envelope: ExecutionEnvelope;
  readonly record: StoreApprovedIntent;
};

export type AuthorizeRefused = {
  readonly outcome: "refused";
  readonly refusal: ExecutionRefusal;
};

export type AuthorizeResult = AuthorizedIntent | AuthorizeRefused;

const refused = (refusal: ExecutionRefusal): AuthorizeRefused => ({ outcome: "refused", refusal });

/**
 * Evaluates a proposal and, if it clears every gate, records the
 * authorization it justifies. Never throws on schema-legal input.
 */
export async function authorizeProposal(
  db: VigilDatabase,
  request: AuthorizeRequest,
): Promise<AuthorizeResult> {
  const { proposal, quote, now, venue, policyConfig, portfolio, capital } = request;

  const side = ACTION_ORDER_SIDES[proposal.action];
  if (side === null) {
    return refused(
      executionRefusal(
        "NON_EXECUTABLE_ACTION",
        `action "${proposal.action}" authorizes no execution; it is a decision to do nothing and is never turned into an order`,
      ),
    );
  }
  if (side === "SELL") {
    return refused(
      executionRefusal(
        "EXIT_PATH_NOT_BUILT",
        `action "${proposal.action}" is an exit, which needs a position basis and realized-P&L accounting this build does not have; this slice authorizes entry actions only`,
      ),
    );
  }

  const expectedInstrumentId = `${proposal.baseAssetId}/${proposal.quoteAssetId}`;
  if (quote.instrumentId !== expectedInstrumentId) {
    return refused(
      executionRefusal(
        "QUOTE_INSTRUMENT_MISMATCH",
        `the quote prices "${quote.instrumentId}" but this proposal trades "${expectedInstrumentId}"`,
      ),
    );
  }

  const priced = priceExecutable(side, quote, venue);
  if (priced.outcome === "unpriceable") {
    return refused(executionRefusal(priced.failure.reason, priced.failure.detail));
  }
  const pricing = priced.pricing;

  const exitUnits = unitsAt(proposal.thesis.expectedExitPriceQuote, venue.moneyScale);
  if (exitUnits === null) {
    return refused(
      executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the thesis exit price "${proposal.thesis.expectedExitPriceQuote}" carries finer precision than the venue's money scale (${String(venue.moneyScale)})`,
      ),
    );
  }
  const grossEdgePerUnitUnits = exitUnits - pricing.units.referenceMid;
  const expectedGrossEdgePerUnitQuote = decimalAt(grossEdgePerUnitUnits, venue.moneyScale);

  const costs = netEdgeCostsFor(pricing);
  const evaluation = evaluateProposal({
    config: policyConfig,
    now,
    account: portfolio.account,
    quote: {
      quoteAcquiredAt: quote.timestamps.quoteAcquiredAt,
      executablePrice: pricing.executionPrice,
    },
    entryZone: proposal.entryZone,
    exposureCaps: [...portfolio.exposureCaps],
    capital: {
      fundsAvailableQuote: capital.fundsAvailableQuote,
      // What the venue can actually fill at or inside the executable price —
      // the top-of-book size on the side being traded, never a last-trade
      // volume (`docs/architecture.md`, "Market/quote engine").
      executableLiquidityBase: quote.askQuantity,
      adverseLossBudgetQuote: capital.adverseLossBudgetQuote,
      stopDistanceQuote: capital.stopDistanceQuote,
    },
    edge: { expectedGrossEdgePerUnitQuote, costs },
  });

  if (evaluation.outcome === "refused") {
    return refused(fromPolicyRefusal(evaluation.refusal));
  }

  const quantityUnits = unitsAt(evaluation.size.quantityBase, venue.quantityScale);
  if (quantityUnits === null || quantityUnits <= 0n) {
    return refused(
      executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the sized quantity "${evaluation.size.quantityBase}" is not a positive quantity the venue can hold at scale ${String(venue.quantityScale)}`,
      ),
    );
  }

  const receiptFloorUnits = unitsAt(proposal.minAcceptableReceiptQuantity, venue.quantityScale);
  const residualUnits = unitsAt(proposal.permittedResidualQuote, venue.moneyScale);
  if (receiptFloorUnits === null || residualUnits === null || receiptFloorUnits < 0n || residualUnits < 0n) {
    return refused(
      executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the proposal's receipt floor ("${proposal.minAcceptableReceiptQuantity}") or permitted residual ("${proposal.permittedResidualQuote}") is negative or finer than the venue's scales`,
      ),
    );
  }
  if (receiptFloorUnits > quantityUnits) {
    return refused(
      policyBlock(
        "MINIMUM_NOTIONAL",
        `the sized quantity ${evaluation.size.quantityBase} is below the stated receipt floor ${proposal.minAcceptableReceiptQuantity}; skipped rather than authorized at a size the plan says is not worth holding`,
      ),
    );
  }

  const envelope = envelopeFor(pricing, quantityUnits);
  const economics = intentEconomicsFor({
    pricing,
    numeraireAssetId: proposal.quoteAssetId,
    envelope,
    grossEdgePerUnitUnits,
    quantityUnits,
    policyConfig,
    venue,
  });
  if (economics.outcome === "refused") {
    return refused(economics.refusal);
  }

  const record: StoreApprovedIntent = {
    intentId: proposal.intentId,
    idempotencyKey: proposal.idempotencyKey,
    correlationId: proposal.correlationId,
    economicActionId: proposal.economicActionId,
    positionPlanId: proposal.positionPlanId,
    candidateId: proposal.candidateId,
    operatingMode: request.operatingMode,
    fundingAccountId: proposal.fundingAccountId,
    venueId: venue.venueId,
    // An exchange venue, never a chain: this build wires one simulated
    // exchange, and an on-chain authorization has no lifecycle to be
    // attempted in until the `transactions` record family exists.
    chainId: null,
    routeId: null,
    input: {
      assetId: proposal.quoteAssetId,
      scale: venue.moneyScale,
      maxSpendBase: envelope.maxSpendUnits,
      permittedResidualBase: residualUnits,
    },
    output: {
      assetId: proposal.baseAssetId,
      scale: venue.quantityScale,
      quantityBase: quantityUnits,
      minAcceptableReceiptBase: receiptFloorUnits,
    },
    validUntil: proposal.validUntil,
    requiredFreshnessMs: proposal.requiredFreshnessMs,
    protectionPlan: proposal.protectionPlan,
    remainingInventoryTreatment: proposal.remainingInventoryTreatment,
    benchmarkId: proposal.benchmarkId,
    approvalReason: proposal.approvalReason,
    adapterCapabilityVersion: venue.adapterCapabilityVersion,
    chainValidation: null,
    approvedAt: now,
    recordedAt: now,
    provenance: {
      policyVersion: proposal.provenance.policyVersion,
      strategyVersion: proposal.provenance.strategyVersion,
      modelVersion: proposal.provenance.modelVersion,
      portfolioSnapshotVersion: proposal.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: proposal.provenance.marketSnapshotVersion,
      // The fee snapshot these costs were priced from. `fee_snapshot_version`
      // is NOT NULL and non-blank-checked, and this is the honest value for
      // it: the snapshot the injected cost model names, never a placeholder.
      feeSnapshotVersion: venue.feeSnapshotVersion,
    },
    economics: {
      quoteId: proposal.quoteId,
      quoteAcquiredAt: quote.timestamps.quoteAcquiredAt,
      costModelVersion: venue.costModelVersion,
      numeraireAssetId: proposal.quoteAssetId,
      numeraireScale: venue.moneyScale,
      notionalBase: envelope.notionalUnits,
      expectedGrossBase: economics.expectedGrossBase,
      expectedTotalCostBase: economics.expectedTotalCostBase,
      expectedNetEdgeBase: economics.expectedNetEdgeBase,
      netEdgeBasis: "hurdle",
      minimumNetEdgeBase: economics.minimumNetEdgeBase,
      costComponents: economics.costComponents,
    },
  };

  // The terms before the result (see the module header). `now` is both the
  // formation and the recording instant: these terms are set by this
  // approval, from this quote, and dating either one differently would put a
  // moment into the timestamp family that nothing actually happened at.
  const planned = await recordPositionPlan(db, {
    positionPlanId: proposal.positionPlanId,
    correlationId: proposal.correlationId,
    instrumentId: expectedInstrumentId,
    entryZoneMin: proposal.entryZone.min,
    entryZoneMax: proposal.entryZone.max,
    thesisExitPrice: proposal.thesis.expectedExitPriceQuote,
    // Evidence, never an input. It is what makes the exit price readable
    // later — a 260.00 target against a 250.05 mid is a different claim than
    // against a 259.00 one — and the dispatch gate never reads it, because
    // gross edge there is measured from the FRESH midpoint.
    formationReferenceMid: decimalAt(pricing.units.referenceMid, venue.moneyScale),
    formedAt: now,
    recordedAt: now,
    provenance: {
      policyVersion: proposal.provenance.policyVersion,
      strategyVersion: proposal.provenance.strategyVersion,
      modelVersion: proposal.provenance.modelVersion,
      portfolioSnapshotVersion: proposal.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: proposal.provenance.marketSnapshotVersion,
    },
  });
  if (planned.outcome === "refused") {
    return refused(
      planned.code === "PLAN_TERMS_CONFLICT"
        ? executionRefusal(
            "POSITION_PLAN_TERMS_CONFLICT",
            `the terms for ${proposal.intentId} could not be recorded under plan ${proposal.positionPlanId}: ${planned.detail}`,
          )
        : executionRefusal(
            "PERSISTENCE_REFUSED",
            `the position plan for ${proposal.intentId} could not be written (${planned.code}): ${planned.detail}`,
          ),
    );
  }

  const written = await recordApprovedIntent(db, record);
  if (written.outcome === "refused") {
    return refused(
      executionRefusal(
        "PERSISTENCE_REFUSED",
        `the authorization for ${proposal.intentId} could not be written (${written.code}): ${written.detail}`,
      ),
    );
  }

  return {
    outcome: "authorized",
    // On a duplicate this is the id of the authorization that ALREADY
    // stands, which is deliberately not `record.intentId` — the record below
    // is what this delivery would have written, sized against this
    // delivery's own quote, and it was not written. Nothing downstream is
    // misled today because `dispatchAttempt` reads the authorization back
    // with `loadApprovedIntent` rather than trusting a record handed to it,
    // but a caller that persisted `record` on a duplicate would be storing a
    // second, never-approved set of numbers under a live id.
    intentId: written.intentId,
    duplicate: written.outcome === "duplicate",
    side,
    quantityUnits,
    evaluation,
    pricing,
    envelope,
    record,
  };
}

type IntentEconomicsInput = {
  readonly pricing: VenuePricingView;
  /** The asset every figure below is denominated in: this venue charges every cost in the quote asset. */
  readonly numeraireAssetId: AssetId;
  readonly envelope: ExecutionEnvelope;
  readonly grossEdgePerUnitUnits: bigint;
  readonly quantityUnits: bigint;
  readonly policyConfig: PolicyConfig;
  readonly venue: VenueExecutionConfig;
};

type IntentEconomicsFigures = {
  readonly outcome: "computed";
  readonly expectedGrossBase: bigint;
  readonly expectedTotalCostBase: bigint;
  readonly expectedNetEdgeBase: bigint;
  readonly minimumNetEdgeBase: bigint;
  readonly costComponents: readonly IntentCostComponent[];
};

type IntentEconomicsResult = IntentEconomicsFigures | { readonly outcome: "refused"; readonly refusal: ExecutionRefusal };

/**
 * The stored economics, in numeraire base units.
 *
 * `@vigil/policy` compares at unbounded decimal precision; the record stores
 * base units at the venue's settlement scale. The conversion rounds the only
 * way that cannot turn a marginal trade into an approved one: **gross down,
 * every cost up**. That makes the stored net edge less than or equal to the
 * exact figure policy cleared, so the last step re-checks the hurdle at the
 * stored precision and refuses rather than writing a row the database's own
 * `approved_intents_net_edge_hurdle` constraint would reject — the same
 * answer, with a reason code instead of a driver error.
 *
 * The two embedded components are itemised separately even though policy
 * consumed their sum, because the durable record is read by an evaluation
 * comparing expected against realized, and the venue reports SPREAD and
 * SLIPPAGE separately on the fill.
 */
function intentEconomicsFor(input: IntentEconomicsInput): IntentEconomicsResult {
  const { pricing, envelope, grossEdgePerUnitUnits, quantityUnits, policyConfig, venue } = input;
  const quantityDivisor = scaleFactor(pricing.quantityScale);

  const grossMagnitude = grossEdgePerUnitUnits < 0n ? -grossEdgePerUnitUnits : grossEdgePerUnitUnits;
  // A positive edge rounds DOWN (understating the benefit); a negative edge
  // rounds its magnitude UP (overstating the loss). Both are the direction
  // that cannot flatter the trade.
  const grossUnits = scaledProduct(
    grossMagnitude,
    quantityUnits,
    quantityDivisor,
    grossEdgePerUnitUnits < 0n ? "UP" : "DOWN",
  );
  const expectedGrossBase = grossEdgePerUnitUnits < 0n ? -grossUnits : grossUnits;

  const spreadUnits = scaledProduct(pricing.units.spreadPerUnit, quantityUnits, quantityDivisor, "UP");
  const slippageUnits = scaledProduct(pricing.units.slippagePerUnit, quantityUnits, quantityDivisor, "UP");
  const expectedTotalCostBase = spreadUnits + slippageUnits + envelope.feeUnits + envelope.fixedUnits;
  const expectedNetEdgeBase = expectedGrossBase - expectedTotalCostBase;

  const minimumNetEdgeBase = unitsAt(policyConfig.minimumNetEdgeQuote, venue.moneyScale);
  if (minimumNetEdgeBase === null) {
    return {
      outcome: "refused",
      refusal: executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the configured minimum net edge "${policyConfig.minimumNetEdgeQuote}" carries finer precision than the venue's money scale (${String(venue.moneyScale)})`,
      ),
    };
  }

  if (expectedNetEdgeBase < minimumNetEdgeBase) {
    return {
      outcome: "refused",
      refusal: policyBlock(
        "INSUFFICIENT_NET_EDGE",
        `at the venue's own settlement precision the expected net edge is ${expectedNetEdgeBase.toString()} base units against a required ${minimumNetEdgeBase.toString()}; the authorization is not written`,
      ),
    };
  }

  const component = (
    kind: CostComponentKindValue,
    chargeBasis: CostChargeBasisValue,
    amount: bigint,
  ): IntentCostComponent => ({
    kind,
    chargeBasis,
    nativeAssetId: input.numeraireAssetId,
    nativeScale: venue.moneyScale,
    nativeAmountBase: amount,
    numeraireAmountBase: amount,
    // Null exactly when the native asset is the numeraire, which it always
    // is here: this venue charges every cost in the quote asset.
    conversionSource: null,
  });

  return {
    outcome: "computed",
    expectedGrossBase,
    expectedTotalCostBase,
    expectedNetEdgeBase,
    minimumNetEdgeBase,
    costComponents: [
      component("spread", "embedded", spreadUnits),
      component("slippage-allowance", "embedded", slippageUnits),
      component("proportional-fee", "separately-charged", envelope.feeUnits),
      component("fixed-costs", "separately-charged", envelope.fixedUnits),
    ],
  };
}
