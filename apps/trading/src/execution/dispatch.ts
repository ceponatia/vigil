import { createHash } from "node:crypto";

import type { AssetId, IsoUtcTimestamp, ReasonCode } from "@vigil/contracts";
import { proposeOrder, reserveOrder, validateOrder } from "@vigil/adapter-paper";
import type { OrderSide, PaperExchange, PaperOrder } from "@vigil/adapter-paper";
import {
  abandonDispatch,
  loadApprovedIntent,
  markDispatched,
  openExecutionAttempt,
  recordAttemptOutcome,
  reserveAvailable,
} from "@vigil/db";
import type { ExecutionAttemptStateValue, StoreApprovedIntent, VigilDatabase } from "@vigil/db";
import type { EntryZone, PolicyConfig } from "@vigil/policy";

import { executionRefusal, fromAdapterRefusal, recordableReasonCode, type ExecutionRefusal } from "./diagnostics";
import {
  revalidateBeforeDispatch,
  type DispatchClearance,
  type PortfolioState,
  type RevalidationStage,
  type ThesisTarget,
} from "./revalidate";
import type { VenueExecutionConfig } from "./venue";
import { decimalAt, scaledProduct } from "./venue-economics";

/**
 * dispatch.ts — consuming an authorization exactly once, in the order
 * `docs/resilience.md` §9 fixes: **intent, reservation, attempt and outbox
 * are durable before anything reaches a venue**, and the pre-dispatch
 * revalidation is the last thing that happens before the payload leaves.
 *
 * ```text
 *   loadApprovedIntent        the authorization, read back from durable history
 *   reserveAvailable          capital held, once per intent
 *   openExecutionAttempt      attempt + outbox row, in one transaction
 *   proposeOrder              PROPOSED
 *   revalidateBeforeDispatch  the fresh quote / net-edge gate  <- blocks here, or
 *   validateOrder             VALIDATED (records that the gate passed)
 *   reserveOrder              RESERVED  (records the hold taken above)
 *   exchange.submitOrder      the one call in this application that reaches a venue
 *   markDispatched            the payload left
 *   recordAttemptOutcome      what the venue said, including UNKNOWN
 * ```
 *
 * ## The four guards against a second spend
 *
 * They are deliberately independent, because each has a failure mode the
 * others do not:
 *
 * 1. `approved_intents.idempotency_key` is unique, so a redelivered proposal
 *    authorizes one spend (`authorize.ts`).
 * 2. A partial unique index counts every non-terminal attempt — `UNKNOWN`
 *    included — as live, so attempt 2 cannot be opened while attempt 1's
 *    fate is unknown. This is where "reconciliation precedes resubmission"
 *    stops being a convention.
 * 3. A partial unique index over `execution_attempts` where `spent_base > 0`
 *    means at most one attempt on an intent may ever record a spend, and the
 *    lifecycle trigger refuses a *new* attempt on an intent some earlier one
 *    already consumed.
 * 4. The venue keeps its own record of every client order id it has
 *    dispatched and refuses a resubmission under one whose outcome no
 *    authoritative read has resolved (`TRANSACTION_UNRESOLVED`).
 *
 * Nothing here relies on the caller not calling twice.
 *
 * ## Why the client order id carries the attempt number
 *
 * `execution_attempts.client_order_id` is globally unique, so a versioned
 * retry needs an id of its own; the intent's idempotency key alone would
 * collide in that table before it ever reached the venue. `key:aN` keeps the
 * authorization visible in the id while making the attempt distinguishable,
 * and it does not weaken guard 4 — a second attempt exists only because
 * guard 2 allowed it, which happens only once the venue has confirmed what
 * became of the first.
 *
 * ## What the caller has to supply, and why
 *
 * The entry zone and the thesis exit price arrive on the request rather than
 * off the intent, because `approved_intents` stores neither: it keeps the
 * *result* of the approval (`expected_gross_base`, the cost breakdown, the
 * hurdle) and not the inputs the result was derived from. Both belong to the
 * position plan the intent already names through `position_plan_id`, which
 * has no record family yet. Until it does, a restarted process cannot
 * revalidate an intent it did not approve in the same run — a real gap,
 * recorded here rather than papered over with a value invented at dispatch.
 */

/** The wiring one effective writer holds for this financial authority domain. */
export type ExecutionRuntime = {
  readonly db: VigilDatabase;
  readonly exchange: PaperExchange;
  readonly venue: VenueExecutionConfig;
  readonly policyConfig: PolicyConfig;
  /** Which writer is claiming these dispatches (`docs/resilience.md` §7). */
  readonly dispatcherInstanceId: string;
  /** Monotonic; a writer carrying a lower token has been fenced. */
  readonly fencingToken: bigint;
};

/**
 * The record ids this dispatch will write. Injected rather than generated
 * here so a replay driving the same scenario twice produces byte-identical
 * rows — the property that makes a fault-injection suite mean anything.
 */
export type DispatchIdentities = {
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly reservationId: string;
  /** The `reservation-hold` entry the hold posts. */
  readonly reservationEntryId: string;
};

export type Instrument = {
  readonly baseAssetId: AssetId;
  readonly quoteAssetId: AssetId;
};

/** The plan's own terms, which the intent record does not carry. See the module header. */
export type PositionPlanTerms = {
  readonly entryZone: EntryZone;
  readonly thesis: ThesisTarget;
};

export type DispatchRequest = {
  readonly intentId: string;
  /** Versioned attempt on that intent; starts at 1. */
  readonly attempt: number;
  readonly instrument: Instrument;
  readonly plan: PositionPlanTerms;
  /** The freshest executable quote, untrusted and parsed at the revalidation boundary. */
  readonly quote: unknown;
  readonly now: IsoUtcTimestamp;
  readonly portfolio: PortfolioState;
  readonly ids: DispatchIdentities;
};

export type DispatchedAttempt = {
  readonly outcome: "dispatched";
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly order: PaperOrder;
  readonly attemptState: ExecutionAttemptStateValue;
  readonly clearance: DispatchClearance;
  /** Set when the venue confirmed a rejection or an expiry, in its own words. */
  readonly venueDetail: string | null;
  /**
   * A durable write that refused AFTER the venue was asked — a fenced writer
   * settling the outbox row, or an outcome the attempt would not take.
   * Surfaced rather than swallowed: the order exists at the venue either way,
   * and a caller that cannot see the write failed would believe durable
   * history describes it.
   */
  readonly persistence: ExecutionRefusal | null;
};

export type BlockedDispatch = {
  readonly outcome: "blocked";
  readonly attemptId: string;
  readonly dispatchId: string;
  /** `"venue"` when every gate passed and the venue itself refused the submission. */
  readonly stage: RevalidationStage | "venue";
  readonly refusal: ExecutionRefusal;
  /**
   * The `docs/policy.md` code this block was recorded under, or `null` when
   * the refusal was a local diagnostic. A null block leaves the outbox row
   * `pending` rather than abandoning it under a code policy never gave —
   * `loadPendingDispatches` still surfaces it and the live attempt still
   * blocks a retry, so nothing is silently skipped.
   */
  readonly recordedReasonCode: ReasonCode | null;
  /** A durable write that refused while recording this block. */
  readonly persistence: ExecutionRefusal | null;
};

export type RefusedDispatch = {
  readonly outcome: "refused";
  readonly refusal: ExecutionRefusal;
};

export type DispatchResult = DispatchedAttempt | BlockedDispatch | RefusedDispatch;

const refused = (refusal: ExecutionRefusal): RefusedDispatch => ({ outcome: "refused", refusal });

/**
 * What this guard reads off an adapter's declaration.
 *
 * Deliberately **wider** than `@vigil/adapter-paper`'s `AdapterCapability`,
 * which types these three as the literal `false`. A parameter of that type
 * would narrow `capability.reachesLiveEndpoint` to `never` inside the `if`,
 * so three of the four checks below would be branches the compiler has
 * already proved unreachable — a gate that reads like a runtime check and can
 * only ever fire on `mode`.
 *
 * A capability is **data an adapter supplies about itself**, and the whole
 * point of checking it is that a future `adapter-<venue>` will declare `true`
 * and must be refused here rather than dispatched to. `boolean` is what that
 * declaration actually is; `AdapterCapability` remains assignable to this, so
 * nothing at the call site changes.
 */
export type DeclaredAdapterCapability = {
  readonly adapterId: string;
  readonly mode: string;
  readonly reachesLiveEndpoint: boolean;
  readonly holdsVenueCredential: boolean;
  readonly canSignTransactions: boolean;
};

/**
 * Whether this adapter is the paper one, checked at runtime rather than
 * trusted from the type.
 *
 * This build dispatches to nothing that reaches an endpoint, holds a
 * credential, or can sign. `docs/policy.md` puts LIVE behind a capability
 * gate no code here can open, so the honest form of that gate here is a
 * refusal to dispatch at all.
 */
export function refuseNonPaperAdapter(capability: DeclaredAdapterCapability): ExecutionRefusal | null {
  const violations: string[] = [];
  if (capability.mode !== "PAPER") {
    violations.push(`declares mode ${capability.mode}`);
  }
  if (capability.reachesLiveEndpoint) {
    violations.push("reaches a live endpoint");
  }
  if (capability.holdsVenueCredential) {
    violations.push("holds a venue credential");
  }
  if (capability.canSignTransactions) {
    violations.push("can sign transactions");
  }
  if (violations.length === 0) {
    return null;
  }
  return executionRefusal(
    "ADAPTER_NOT_PAPER",
    `adapter "${capability.adapterId}" ${violations.join(", ")}; this build dispatches only to a PAPER adapter with none of those capabilities`,
  );
}

/**
 * Which side of the book this authorization trades, derived from the assets
 * it names rather than from a column. `approved_intents` stores no action —
 * the action lives on the candidate — so the instrument being dispatched
 * against is what disambiguates, and an intent whose assets are not that
 * instrument's pair is refused rather than guessed at.
 */
export function sideFor(intent: StoreApprovedIntent, instrument: Instrument): OrderSide | null {
  if (intent.input.assetId === instrument.quoteAssetId && intent.output.assetId === instrument.baseAssetId) {
    return "BUY";
  }
  if (intent.input.assetId === instrument.baseAssetId && intent.output.assetId === instrument.quoteAssetId) {
    return "SELL";
  }
  return null;
}

/**
 * A SHA-256 digest of what this dispatch will send — never the payload
 * itself. `intent_dispatch_outbox.payload_digest` is immutable, so a resumed
 * dispatcher can prove the payload it is about to send is the one that was
 * authorized without the payload ever being stored.
 *
 * The fields are listed explicitly, in a fixed order, and serialized as a
 * JSON **array**: array order is part of the encoding and every value is
 * escaped, so no two different field sets can produce the same material.
 * Serializing the order object instead would make the digest depend on key
 * insertion order and on fields the venue is never told.
 */
export function payloadDigestFor(order: PaperOrder): string {
  const material = JSON.stringify([
    order.clientOrderId,
    String(order.attempt),
    order.venueId,
    order.side,
    order.quantity,
    order.inputAssetId,
    order.outputAssetId,
    order.envelope.maxSpend,
    order.envelope.minAcceptableReceipt,
    order.envelope.permittedResidual,
    order.envelope.validUntil,
    String(order.envelope.requiredFreshnessMs),
    order.capabilityVersion,
    order.provenance.intentId,
    order.provenance.economicActionId,
    order.provenance.correlationId,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** The id the venue sees for one versioned attempt on one authorization. */
export function clientOrderIdFor(idempotencyKey: string, attempt: number): string {
  return `${idempotencyKey}:a${String(attempt)}`;
}

/**
 * Carries one approved intent through its next versioned attempt: hold the
 * capital, make the attempt durable, revalidate, and only then ask the
 * venue. Never throws on schema-legal input.
 */
export async function dispatchAttempt(runtime: ExecutionRuntime, request: DispatchRequest): Promise<DispatchResult> {
  const { db, exchange, venue, policyConfig } = runtime;
  const { intentId, attempt, instrument, now, ids } = request;

  const notPaper = refuseNonPaperAdapter(exchange.capability);
  if (notPaper !== null) {
    return refused(notPaper);
  }

  const intent = await loadApprovedIntent(db, intentId);
  if (intent === null) {
    return refused(
      executionRefusal(
        "UNKNOWN_INTENT",
        `intent ${intentId} is not in durable history; nothing authorizes an attempt on it`,
      ),
    );
  }

  if (intent.operatingMode !== "PAPER") {
    return refused(
      executionRefusal(
        "OPERATING_MODE_NOT_PAPER",
        `intent ${intentId} was approved in ${intent.operatingMode}; this build dispatches only what PAPER authorized`,
      ),
    );
  }

  const side = sideFor(intent, instrument);
  if (side === null) {
    return refused(
      executionRefusal(
        "QUOTE_INSTRUMENT_MISMATCH",
        `intent ${intentId} spends ${intent.input.assetId} for ${intent.output.assetId}, which is neither direction of ${instrument.baseAssetId}/${instrument.quoteAssetId}`,
      ),
    );
  }

  // ---- persistence before action (docs/resilience.md §9) ------------------
  //
  // The hold is taken once per INTENT, not once per attempt: the partial
  // unique index over `reservations` where `state = 'active'` allows exactly
  // one live hold per intent, and a versioned retry spends the capital the
  // first hold already committed. A deterministic idempotency key is what
  // makes the second call return the standing hold instead of refusing.
  const held = await reserveAvailable(db, {
    reservationId: ids.reservationId,
    intentId,
    attempt: 1,
    idempotencyKey: `reserve:${intentId}`,
    correlationId: intent.correlationId,
    entryId: ids.reservationEntryId,
    assetId: intent.input.assetId,
    scale: intent.input.scale,
    amountBase: intent.input.maxSpendBase,
    occurredAt: now,
    recordedAt: now,
    expiresAt: intent.validUntil,
    provenance: {
      policyVersion: intent.provenance.policyVersion,
      strategyVersion: intent.provenance.strategyVersion,
      modelVersion: intent.provenance.modelVersion,
      portfolioSnapshotVersion: intent.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: intent.provenance.marketSnapshotVersion,
    },
  });
  if (held.outcome === "refused") {
    return refused(
      executionRefusal(
        "RESERVATION_REFUSED",
        `capital for intent ${intentId} could not be held (${held.code}): ${held.detail}`,
      ),
    );
  }

  const clientOrderId = clientOrderIdFor(intent.idempotencyKey, attempt);
  const proposed = proposeOrder({
    intent: adapterIntentFor({ intent, side, clientOrderId, venue }),
    at: now,
    attempt,
  });
  if (!proposed.accepted) {
    return refused(fromAdapterRefusal(proposed.refusal));
  }
  const order = proposed.order;

  const opened = await openExecutionAttempt(db, {
    attemptId: ids.attemptId,
    intentId,
    attempt,
    clientOrderId,
    submittedAt: now,
    recordedAt: now,
    dispatch: {
      dispatchId: ids.dispatchId,
      payloadDigest: payloadDigestFor(order),
      dispatcherInstanceId: runtime.dispatcherInstanceId,
      fencingToken: runtime.fencingToken,
      enqueuedAt: now,
    },
  });
  if (opened.outcome === "refused") {
    return refused(
      executionRefusal(
        "PERSISTENCE_REFUSED",
        `attempt ${String(attempt)} on intent ${intentId} could not be opened (${opened.code}): ${opened.detail}`,
      ),
    );
  }

  // ---- the pre-dispatch gate ---------------------------------------------
  const clearance = revalidateBeforeDispatch({
    intent: {
      intentId,
      side,
      baseAssetId: instrument.baseAssetId,
      quoteAssetId: instrument.quoteAssetId,
      quantityUnits: intent.output.quantityBase,
      entryZone: request.plan.entryZone,
      requiredFreshnessMs: intent.requiredFreshnessMs,
    },
    thesis: request.plan.thesis,
    quote: request.quote,
    now,
    venue,
    policyConfig,
    portfolio: request.portfolio,
  });

  if (clearance.outcome === "blocked") {
    const abandoned = await abandonIfPolicySaidSo(runtime, request, clearance.refusal);
    return {
      outcome: "blocked",
      attemptId: opened.attemptId,
      dispatchId: opened.dispatchId,
      stage: clearance.stage,
      refusal: clearance.refusal,
      recordedReasonCode: abandoned.reasonCode,
      persistence: abandoned.persistence,
    };
  }

  // The caller-side transitions, recorded now that each step has actually
  // happened: policy validated immediately above, capital held further above.
  const validated = validateOrder(order, now);
  if (!validated.applied) {
    return refused(fromAdapterRefusal(validated.refusal));
  }
  const reserved = reserveOrder(validated.order, now);
  if (!reserved.applied) {
    return refused(fromAdapterRefusal(reserved.refusal));
  }

  // ---- the one call in this application that reaches a venue -------------
  const submitted = exchange.submitOrder({ order: reserved.order, quote: clearance.quote, now });
  if (submitted.outcome === "REFUSED") {
    const refusal = fromAdapterRefusal(submitted.refusal);
    const abandoned = await abandonIfPolicySaidSo(runtime, request, refusal);
    return {
      outcome: "blocked",
      attemptId: opened.attemptId,
      dispatchId: opened.dispatchId,
      stage: "venue",
      refusal,
      recordedReasonCode: abandoned.reasonCode,
      persistence: abandoned.persistence,
    };
  }

  const marked = await markDispatched(db, {
    intentId,
    attempt,
    dispatcherInstanceId: runtime.dispatcherInstanceId,
    fencingToken: runtime.fencingToken,
    recordedAt: now,
    dispatchedAt: now,
  });

  const attemptState = attemptStateFor(submitted.order.state);
  const recorded = await recordAttemptOutcome(db, {
    intentId,
    attempt,
    state: attemptState,
    // Nothing is confirmed spent or received at submission: what the venue
    // does with the order is a later fact, and `UNKNOWN` is the state that
    // says so rather than a zero that would read as "nothing happened".
    spentBase: 0n,
    receivedBase: 0n,
    venueOrderId: submitted.order.venueOrderId,
    stateChangedAt: now,
    recordedAt: now,
    reconciliation: null,
  });

  return {
    outcome: "dispatched",
    attemptId: opened.attemptId,
    dispatchId: opened.dispatchId,
    order: submitted.order,
    attemptState,
    clearance,
    venueDetail: submitted.outcome === "REJECTED" || submitted.outcome === "EXPIRED" ? submitted.detail : null,
    persistence:
      describeWriteRefusal(marked, `the dispatch for attempt ${String(attempt)} on intent ${intentId}`) ??
      describeWriteRefusal(recorded, `the outcome of attempt ${String(attempt)} on intent ${intentId}`),
  };
}

/**
 * The shape every `@vigil/db` write result shares: a refusal carrying a code
 * and a detail, or anything else, which means it took.
 */
type DurableWriteResult =
  | { readonly outcome: "refused"; readonly code: string; readonly detail: string }
  | { readonly outcome: "recorded" | "duplicate" | "opened" | "posted" | "reserved" };

/** A durable write that refused, as an execution diagnostic; `null` when it succeeded. */
function describeWriteRefusal(result: DurableWriteResult, what: string): ExecutionRefusal | null {
  if (result.outcome !== "refused") {
    return null;
  }
  return executionRefusal("PERSISTENCE_REFUSED", `${what} could not be recorded (${result.code}): ${result.detail}`);
}

/**
 * Abandons the dispatch when — and only when — the refusal is a policy
 * decision carrying a `docs/policy.md` code.
 *
 * A local diagnostic leaves the row `pending` on purpose. `abandonDispatch`
 * writes a reason code onto durable history, and the nearest plausible code
 * for a malformed cost model or an unreachable answer would put a decision
 * policy never made into the record an operator reads. A pending row is
 * still visible to `loadPendingDispatches`, the attempt is still live and
 * still blocks a retry, and the same payload can be dispatched once the
 * configuration is fixed — its digest has not changed.
 */
async function abandonIfPolicySaidSo(
  runtime: ExecutionRuntime,
  request: DispatchRequest,
  refusal: ExecutionRefusal,
): Promise<{ readonly reasonCode: ReasonCode | null; readonly persistence: ExecutionRefusal | null }> {
  const reasonCode = recordableReasonCode(refusal);
  if (reasonCode === null) {
    return { reasonCode: null, persistence: null };
  }
  const abandoned = await abandonDispatch(runtime.db, {
    intentId: request.intentId,
    attempt: request.attempt,
    dispatcherInstanceId: runtime.dispatcherInstanceId,
    fencingToken: runtime.fencingToken,
    recordedAt: request.now,
    reasonCode,
  });
  return {
    // Reported as recorded only when the write actually took. A caller that
    // was told the block was journaled under a code, when it was not, would
    // believe durable history explains a skip that nothing explains.
    reasonCode: abandoned.outcome === "refused" ? null : reasonCode,
    persistence: describeWriteRefusal(
      abandoned,
      `the abandonment of attempt ${String(request.attempt)} on intent ${request.intentId}`,
    ),
  };
}

/**
 * The order lifecycle and the attempt lifecycle are spelled identically
 * (`docs/architecture.md` "Execution lifecycles"), but only the states an
 * attempt can hold are legal in the column. `PROPOSED`, `VALIDATED` and
 * `RESERVED` are caller-side steps that happen before an attempt row exists
 * at all, so they map to `SUBMITTING` — the state every attempt is born in.
 */
export function attemptStateFor(state: PaperOrder["state"]): ExecutionAttemptStateValue {
  switch (state) {
    case "PROPOSED":
    case "VALIDATED":
    case "RESERVED":
    case "SUBMITTING":
      return "SUBMITTING";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "CANCEL_PENDING":
      return "CANCEL_PENDING";
    case "UNKNOWN":
      return "UNKNOWN";
    case "FILLED":
      return "FILLED";
    case "CANCELED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
  }
}

type AdapterIntentInput = {
  readonly intent: StoreApprovedIntent;
  readonly side: OrderSide;
  readonly clientOrderId: string;
  readonly venue: VenueExecutionConfig;
};

/**
 * The execution-relevant subset `@vigil/adapter-paper` parses, built from the
 * durable authorization rather than from anything held in memory since
 * approval.
 *
 * One field is translated rather than passed through, and the difference is
 * not cosmetic. `approved_intents.permitted_residual_base` is denominated in
 * the **input** asset — the schema constrains it against `max_spend_base` —
 * while the adapter compares its `permittedResidual` against an unfilled
 * **base-asset quantity** (`settlementOf`'s `residualExceedsPermitted`). For
 * a buy those are different assets, so passing the stored amount through
 * under a matching field name would compare a quote amount to a base
 * quantity. It is converted at the intent's own approved ratio instead —
 * `max_spend_base` bought `quantity_base`, so the residual's quantity share
 * is that same ratio — which is derived from the authorization rather than
 * from a live price, so the same intent always converts to the same
 * residual. It floors, which makes the permitted residual smaller and
 * `residualExceedsPermitted` more likely to fire: an operator asked about a
 * leftover that turns out to be dust is the recoverable direction.
 */
function adapterIntentFor(input: AdapterIntentInput): unknown {
  const { intent, side, clientOrderId } = input;

  return {
    intentId: intent.intentId,
    economicActionId: intent.economicActionId,
    positionPlanId: intent.positionPlanId,
    idempotencyKey: clientOrderId,
    correlationId: intent.correlationId,
    venueId: intent.venueId,
    // `approved_intents` stores no action — the action lives on the candidate
    // this intent came from — so the side derived from the assets is what is
    // restated here. BUY and ADD are indistinguishable at this point, which
    // matters for reporting and not for the order.
    action: side,
    inputAssetId: intent.input.assetId,
    outputAssetId: intent.output.assetId,
    quantity: decimalAt(intent.output.quantityBase, intent.output.scale),
    maxSpend: decimalAt(intent.input.maxSpendBase, intent.input.scale),
    minAcceptableReceipt: decimalAt(intent.output.minAcceptableReceiptBase, intent.output.scale),
    permittedResidual: residualQuantityFor(input),
    validUntil: intent.validUntil,
    requiredFreshnessMs: intent.requiredFreshnessMs,
    adapterCapabilityVersion: intent.adapterCapabilityVersion,
    policyVersion: intent.provenance.policyVersion,
    strategyVersion: intent.provenance.strategyVersion,
    modelVersion: intent.provenance.modelVersion,
    portfolioSnapshotVersion: intent.provenance.portfolioSnapshotVersion,
    marketSnapshotVersion: intent.provenance.marketSnapshotVersion,
    feeSnapshotVersion: intent.provenance.feeSnapshotVersion,
  };
}

/**
 * The stored input-asset residual, expressed as the base-asset quantity the
 * adapter compares against. A sell already holds its residual in the base
 * asset, so it passes through unchanged.
 */
function residualQuantityFor(input: AdapterIntentInput): string {
  const { intent, side, venue } = input;
  if (side === "SELL") {
    return decimalAt(intent.input.permittedResidualBase, intent.input.scale);
  }
  const quantityUnits = scaledProduct(
    intent.input.permittedResidualBase,
    intent.output.quantityBase,
    intent.input.maxSpendBase,
    "DOWN",
  );
  return decimalAt(quantityUnits, venue.quantityScale);
}
