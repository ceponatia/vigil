import { createHash } from "node:crypto";

import type { IsoUtcTimestamp, ReasonCode } from "@vigil/contracts";
import { proposeOrder, reserveOrder, validateOrder } from "@vigil/adapter-paper";
import type { OrderSide, PaperExchange, PaperOrder } from "@vigil/adapter-paper";
import {
  loadApprovedIntent,
  loadPositionPlan,
  markDispatched,
  recordCandidateEvaluation,
  openExecutionAttempt,
  recordAttemptOutcome,
  reserveAvailable,
} from "@vigil/db";
import type { ExecutionAttemptStateValue, StoreApprovedIntent, VigilDatabase } from "@vigil/db";
import type { PolicyConfig } from "@vigil/policy";

import { executionRefusal, fromAdapterRefusal, recordableReasonCode, type ExecutionRefusal } from "./diagnostics";
import { instrumentIdOf, planTermsFor, type Instrument, type PositionPlanTerms } from "./position-plan";
import {
  revalidateBeforeDispatch,
  type DispatchBlocked,
  type DispatchClearance,
  type PortfolioState,
  type RevalidationStage,
} from "./revalidate";
import type { VenueExecutionConfig } from "./venue";
import { decimalAt } from "./venue-economics";

/**
 * dispatch.ts — consuming an authorization exactly once, in the order
 * `docs/resilience.md` §9 fixes: **intent, reservation, attempt and outbox
 * are durable before anything reaches a venue**, and the pre-dispatch
 * revalidation is the last thing that happens before the payload leaves.
 *
 * ```text
 *   loadApprovedIntent        the authorization, read back from durable history
 *   loadPositionPlan          the terms it was approved against, likewise
 *   proposeOrder              PROPOSED                       (pure, nothing durable)
 *   revalidateBeforeDispatch  the fresh quote / net-edge gate <- blocks here, leaving
 *                                                               NOTHING durable behind
 *   validateOrder             VALIDATED (the gate passed)
 *   reserveAvailable          capital held, once per intent
 *   reserveOrder              RESERVED  (the hold above)
 *   openExecutionAttempt      attempt + outbox row, in one transaction
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
 * ## Why the gate runs before anything is written
 *
 * `docs/resilience.md` §9 requires the intent and the reservation to be
 * durable before **submission**. The revalidation is not a submission — it
 * is a pure local computation, and when it refuses nothing has been handed
 * to a venue. Writing the hold and the attempt first would make every
 * ordinary `INSUFFICIENT_NET_EDGE` skip — the case this whole slice exists
 * for — leave a live `SUBMITTING` attempt that
 * `execution_attempts_intent_id_live_key` then refuses to follow with
 * another, and a hold no exported path can release, because a release needs
 * a settled attempt that actually spent something. The authorization and its
 * capital would be stranded by the gate working correctly.
 *
 * ## Where the gate's own inputs come from
 *
 * Nowhere in memory. `approved_intents` keeps the *result* of the approval
 * (`expected_gross_base`, the cost breakdown, the hurdle) and not the inputs
 * that result was derived from, so the entry zone and the thesis exit price
 * are read back from `position_plans` — the record the intent has always
 * named through `position_plan_id` — by `loadPositionPlan` below, at the
 * start of every dispatch. A caller supplies neither, and there is no field
 * on `DispatchRequest` for one, which is what makes "a process that
 * restarted between approval and dispatch can still revalidate" a property
 * of the type rather than a convention.
 *
 * What is read back is the **thesis exit price**, not a per-unit edge. The
 * distinction is the whole point: a stored per-unit edge is the figure that
 * was true at approval, and it would clear its hurdle forever however far
 * the market had since moved. The exit price is fixed by the thesis and the
 * midpoint is not, so `revalidate.ts` measures one against a fresh reading
 * of the other, and an intent whose edge has been eaten fails exactly as it
 * should.
 *
 * An intent whose plan is missing, prices another instrument, or carries a
 * price this build cannot read is refused before anything is held or
 * written. Inventing terms at the gate would clear a band nobody approved.
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
  /**
   * The `candidate_evaluations` row a refused pre-dispatch gate writes.
   * Injected like every other id here, and that is what makes the write
   * idempotent: the same delivery re-run carries the same id and records one
   * decision, while a genuinely new evaluation gets a new one from the
   * caller.
   */
  readonly blockedEvaluationId: string;
};

export type DispatchRequest = {
  readonly intentId: string;
  /** Versioned attempt on that intent; starts at 1. */
  readonly attempt: number;
  readonly instrument: Instrument;
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
  /**
   * `null` when the pre-dispatch gate refused, which is the ordinary case:
   * nothing durable was written at all, so there is no attempt and no outbox
   * row to name. Non-null only on the `"venue"` stage, where the gate had
   * already cleared and the attempt was made durable before the venue was
   * asked.
   */
  readonly attemptId: string | null;
  readonly dispatchId: string | null;
  /** `"venue"` when every gate passed and the venue itself refused the submission. */
  readonly stage: RevalidationStage | "venue";
  readonly refusal: ExecutionRefusal;
  /**
   * The `docs/policy.md` code this skip carries, or `null` when the refusal
   * was a local diagnostic rather than a decision about the proposal.
   *
   * **This domain does not write it down.** A gate refusal leaves no durable
   * trace by design — that is what keeps the authorization retryable — and a
   * skip is a *decision*, which `docs/architecture.md` puts in the
   * `decisions` record family: a `candidate_evaluations` row with a
   * `BLOCKED` outcome, exactly as `packages/db`'s intent store says ("a
   * refusal is a `candidate_evaluations` row ... not a
   * `rejection_reason_code` on the authorization"). That row needs a
   * candidate, and `candidate_evaluations.candidate_id` is `NOT NULL`, so
   * only the caller — which holds the candidate this intent came from, and
   * which may legitimately have none for a protective action — can write it.
   * This field is what it records.
   */
  readonly reasonCode: ReasonCode | null;
  /**
   * The `candidate_evaluations` row this skip was journaled as, or `null`
   * when none was written — see `recordBlockedDecision`.
   */
  readonly evaluationId: string | null;
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
        `intent ${intentId} spends ${intent.input.assetId} for ${intent.output.assetId}, which is neither direction of ${instrumentIdOf(instrument)}`,
      ),
    );
  }

  // The exchange attempt lifecycle cannot describe a broadcast, and
  // `openExecutionAttempt` refuses an on-chain authorization outright. Caught
  // here, before any capital is held, so a chain-routed intent cannot leave a
  // hold behind that no attempt will ever consume.
  if (intent.chainId !== null) {
    return refused(
      executionRefusal(
        "CHAIN_LIFECYCLE_UNSUPPORTED",
        `intent ${intentId} routes over chain ${intent.chainId}; the exchange attempt lifecycle cannot describe a broadcast, and the transactions record family is not built`,
      ),
    );
  }

  // The gate's own inputs, read back from durable history rather than taken
  // from the caller. This is the whole of what a restarted process needs and
  // could not otherwise have: `approved_intents` carries the result of the
  // approval and not the entry zone or the exit target it was derived from.
  //
  // Before any capital is held and before the order is even proposed, so an
  // authorization whose plan is missing or unusable refuses without leaving a
  // hold, an attempt, or an outbox row behind — exactly as a refused gate
  // does, and for the same reason: nothing has been handed to a venue.
  const storedPlan = await loadPositionPlan(db, intent.positionPlanId);
  if (storedPlan === null) {
    return refused(
      executionRefusal(
        "UNKNOWN_POSITION_PLAN",
        `intent ${intentId} names position plan ${intent.positionPlanId}, which is not in durable history; nothing states the entry zone it was approved within or the exit price its edge is measured against`,
      ),
    );
  }
  const planned = planTermsFor(storedPlan, instrument, intentId);
  if (planned.outcome === "refused") {
    return refused(planned.refusal);
  }
  const plan: PositionPlanTerms = planned.terms;

  // `proposeOrder` is pure — it parses the authorization and opens a
  // `PROPOSED` order in memory. Nothing durable happens until the gate below
  // has passed.
  const clientOrderId = clientOrderIdFor(intent.idempotencyKey, attempt);
  const proposed = proposeOrder({
    intent: adapterIntentFor({ intent, side, clientOrderId }),
    at: now,
    attempt,
  });
  if (!proposed.accepted) {
    return refused(fromAdapterRefusal(proposed.refusal));
  }
  const order = proposed.order;

  // ---- the pre-dispatch gate, BEFORE anything is made durable ------------
  //
  // `docs/resilience.md` §9 requires the intent and the reservation to be
  // persisted before **submission**. This gate is not a submission: it is a
  // pure local computation over a quote, and nothing has been handed to a
  // venue when it refuses. Running it first is what makes a refusal leave no
  // durable trace at all — no hold, no attempt row, no outbox row — so the
  // authorization stays exactly as retryable as it was.
  //
  // The order matters more than it looks. `INSUFFICIENT_NET_EDGE` is this
  // slice's designed-for common case, not an exotic fault. Holding capital
  // and opening an attempt first would mean every ordinary skip left a live
  // `SUBMITTING` attempt — which `execution_attempts_intent_id_live_key`
  // then refuses to follow with another, permanently — and a hold that no
  // exported path can release, because a release needs a settled attempt
  // that actually spent something. A handful of skips would strand the whole
  // funding account.
  const clearance = revalidateBeforeDispatch({
    intent: {
      intentId,
      side,
      baseAssetId: instrument.baseAssetId,
      quoteAssetId: instrument.quoteAssetId,
      quantityUnits: intent.output.quantityBase,
      entryZone: plan.entryZone,
      requiredFreshnessMs: intent.requiredFreshnessMs,
    },
    thesis: plan.thesis,
    quote: request.quote,
    now,
    venue,
    policyConfig,
    portfolio: request.portfolio,
  });

  if (clearance.outcome === "blocked") {
    const journaled = await recordBlockedDecision(runtime, request, intent, clearance);
    return {
      outcome: "blocked",
      attemptId: null,
      dispatchId: null,
      stage: clearance.stage,
      refusal: clearance.refusal,
      reasonCode: recordableReasonCode(clearance.refusal),
      evaluationId: journaled.evaluationId,
      persistence: journaled.persistence,
    };
  }

  // Policy validated, on this quote, a moment ago.
  const validated = validateOrder(order, now);
  if (!validated.applied) {
    return refused(fromAdapterRefusal(validated.refusal));
  }

  // ---- persistence before submission (docs/resilience.md §9) -------------
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

  const reserved = reserveOrder(validated.order, now);
  if (!reserved.applied) {
    return refused(fromAdapterRefusal(reserved.refusal));
  }

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
    return refused(describeOpenRefusal(opened.code, opened.detail, intentId, attempt));
  }

  // ---- the one call in this application that reaches a venue -------------
  const submitted = exchange.submitOrder({ order: reserved.order, quote: clearance.quote, now });
  if (submitted.outcome === "REFUSED") {
    const venueRefusal = fromAdapterRefusal(submitted.refusal);
    // Deliberately NOT abandoned. The gate cleared and the venue then refused,
    // so this application's model of the venue and the venue's own answer
    // disagree — an incident, not a skip. The outbox row stays `pending` and
    // the attempt stays live, which is what keeps both visible to
    // `loadUnresolvedDispatches` and to the one-live-attempt index; marking
    // the row `abandoned` would hide an unresolved dispatch from every read
    // that exists to find one.
    return {
      outcome: "blocked",
      attemptId: opened.attemptId,
      dispatchId: opened.dispatchId,
      stage: "venue",
      refusal: venueRefusal,
      reasonCode: recordableReasonCode(venueRefusal),
      // Deliberately not journaled as a candidate decision. The gate had
      // already cleared, so this is the venue disagreeing with this
      // application's model — an incident about an execution, not a
      // judgement about the candidate — and a `BLOCKED` evaluation would
      // claim policy refused something it approved.
      evaluationId: null,
      persistence: null,
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
 * Why an attempt could not be opened, in this domain's vocabulary.
 *
 * `@vigil/db` distinguishes three situations whose correct responses are
 * opposite — reconcile and then retry, never retry, retry later — and
 * flattening all three into one code with the real one buried in prose would
 * leave a retry driver parsing a sentence to decide whether it may act.
 */
function describeOpenRefusal(
  code: string,
  detail: string,
  intentId: string,
  attempt: number,
): ExecutionRefusal {
  const where = `attempt ${String(attempt)} on intent ${intentId}`;
  if (code === "INTENT_ALREADY_LIVE") {
    return executionRefusal(
      "ATTEMPT_ALREADY_LIVE",
      `${where} cannot be opened while an earlier attempt is unresolved; reconciliation precedes resubmission (${detail})`,
    );
  }
  if (code === "INTENT_ALREADY_CONSUMED") {
    return executionRefusal(
      "INTENT_ALREADY_CONSUMED",
      `${where} cannot be opened: this authorization has already been economically consumed, and a remainder is a new authorization rather than a further attempt (${detail})`,
    );
  }
  if (code === "CHAIN_LIFECYCLE_UNSUPPORTED") {
    return executionRefusal("CHAIN_LIFECYCLE_UNSUPPORTED", `${where}: ${detail}`);
  }
  return executionRefusal("PERSISTENCE_REFUSED", `${where} could not be opened (${code}): ${detail}`);
}

/**
 * Journals a refused pre-dispatch gate as the decision it is.
 *
 * A skip is not a non-event. `docs/product.md` makes refusing uneconomic
 * turnover a success criterion, and `docs/evaluation.md`'s opportunity
 * journal exists so one can be analysed afterwards — which an in-memory
 * result cannot be, because it dies with the process. So the reason code
 * goes somewhere durable.
 *
 * It goes to `candidate_evaluations`, not onto the authorization.
 * `docs/architecture.md` puts every decision — "including WAIT, rejected,
 * expired, and missed entries" — in the `decisions` family, and
 * `packages/db`'s intent store is explicit that `approved_intents` carries no
 * `rejection_reason_code` because a row there exists only because policy
 * approved: "a refusal is a `candidate_evaluations` row with a `BLOCKED`
 * outcome and a reason code from `docs/policy.md`".
 *
 * ## The gap this leaves, which is not a missing line of code
 *
 * `candidate_evaluations.candidate_id` is `NOT NULL` behind a foreign key,
 * and `approved_intents.candidate_id` is nullable **by design**: a
 * protective action has no candidate, and `docs/resilience.md` §2 forbids a
 * schema that would block one. So a policy refusal against a protective
 * unwind has nowhere in this family to go. That is a missing record family
 * rather than something this function can paper over, and inventing a
 * candidate row to hang it on would put a fabricated decision into the
 * journal an operator reads. The refusal still reaches the caller on the
 * result; it is simply not journaled here, and `evaluationId` is `null` so
 * nothing can mistake one case for the other.
 *
 * A failed write never turns a refusal into anything else: no economic
 * action is proceeding, so there is nothing for it to gate. It is reported
 * beside the block.
 */
async function recordBlockedDecision(
  runtime: ExecutionRuntime,
  request: DispatchRequest,
  intent: StoreApprovedIntent,
  clearance: DispatchBlocked,
): Promise<{ readonly evaluationId: string | null; readonly persistence: ExecutionRefusal | null }> {
  const candidateId = intent.candidateId;
  if (candidateId === null) {
    return { evaluationId: null, persistence: null };
  }

  const written = await recordCandidateEvaluation(runtime.db, {
    evaluationId: request.ids.blockedEvaluationId,
    idempotencyKey: `block:${request.ids.blockedEvaluationId}`,
    candidateId,
    outcome: "BLOCKED",
    // Null for a local diagnostic: the column takes a `REASON_CODES` member
    // or nothing, and a configuration bug is not a policy judgement about
    // this candidate.
    reasonCode: recordableReasonCode(clearance.refusal),
    detail: clearance.refusal.detail,
    // The price the gate actually judged — the execution price, which is
    // what this dispatch would have paid, not the quoted ask.
    executablePrice: clearance.pricing?.executionPrice ?? null,
    quoteAcquiredAt: clearance.quoteAcquiredAt,
    evaluatedAt: clearance.blockedAt,
    recordedAt: request.now,
  });

  if (written.outcome === "refused") {
    return {
      evaluationId: null,
      persistence: executionRefusal(
        "PERSISTENCE_REFUSED",
        `the skip of intent ${request.intentId} could not be journaled against candidate ${candidateId} (${written.code}): ${written.detail}`,
      ),
    };
  }
  return { evaluationId: written.evaluationId, persistence: null };
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
};

/**
 * The execution-relevant subset `@vigil/adapter-paper` parses, built from the
 * durable authorization rather than from anything held in memory since
 * approval.
 *
 * **Every amount is passed through in the asset and at the scale it was
 * stored in.** Nothing is converted here, and that is worth stating because
 * an earlier revision did convert one field: `permitted_residual_base` was
 * translated to an output-asset quantity at the intent's own approved ratio,
 * to compensate for `@vigil/adapter-paper` comparing its `permittedResidual`
 * against an unfilled base-asset quantity. The two packages now agree that
 * the residual denominates the **input** asset — the decision is recorded on
 * `permittedResidualBase` in `packages/db/src/schema/intents.ts` — and the
 * adapter's `settlementOf` measures it as `maxSpend` less the input actually
 * consumed. A conversion at this seam would now be the bug.
 *
 * The asset each field carries, since the names alone do not say it: `input`
 * is what the action spends and `output` what it acquires, so `maxSpend` and
 * `permittedResidual` are input-asset amounts while `quantity` and
 * `minAcceptableReceipt` are output-asset quantities.
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
    permittedResidual: decimalAt(intent.input.permittedResidualBase, intent.input.scale),
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
