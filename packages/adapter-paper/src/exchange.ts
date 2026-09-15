import { ageMs } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";
import { evaluateQuoteFreshness } from "@vigil/market";

import { PAPER_ADAPTER_CAPABILITY, PAPER_ADAPTER_CAPABILITY_VERSION } from "./capability";
import type { AdapterCapability } from "./capability";
import { adapterRefusal, policyRefusal } from "./diagnostics";
import type { PaperRefusal } from "./diagnostics";
import { ACKNOWLEDGE_AND_FILL } from "./faults";
import type { ExecutionBehavior, ReconciliationCoverage, RestingBehavior, VenueBehavior } from "./faults";
import type { OrderSide } from "./intent";
import { applyOrderTransition } from "./order";
import type { OrderExecution, PaperOrder } from "./order";
import { isLegalOrderTransition, isLiveOrderState, isTerminalOrderState } from "./order-state";
import type { OrderState } from "./order-state";
import { compareDecimals, mulDiv, renderUnits, scaleFactor, splitUnits, unitsOf } from "./venue-math";

/**
 * exchange.ts — the simulated venue.
 *
 * The one idea this module is built around: THE VENUE'S STATE AND THE
 * CALLER'S VIEW OF IT ARE DIFFERENT THINGS. `createPaperExchange` owns a
 * private order book that is the venue's own truth; a `PaperOrder` is what
 * the caller managed to observe. Every fault here is a divergence between
 * the two, and `readVenueState` is the only thing that closes the gap —
 * which is what makes reconciliation a real operation rather than reading
 * back a variable you just wrote.
 *
 * Consequences that are load-bearing rather than stylistic:
 *
 * - A submission timeout leaves the caller at `UNKNOWN` whether or not the
 *   venue accepted the order. The caller genuinely cannot tell, and this
 *   adapter offers no way to peek: the only route out is a reconciliation
 *   read (`docs/resilience.md` §3).
 * - Resubmitting under a client order id the venue already holds is
 *   REFUSED, not deduplicated: `TRANSACTION_UNRESOLVED` while that order is
 *   still working, `IDEMPOTENCY_KEY_ALREADY_USED` once it is terminal. An
 *   approved intent is consumable exactly once and reconciliation precedes
 *   resubmission (`docs/architecture.md` "Execution lifecycles"), so the
 *   adapter refuses rather than quietly returning the existing order and
 *   letting a caller believe its retry did something.
 * - Nothing is released on an unsettled order. `settlementOf` reports
 *   `releasableRemainder: null` for every non-terminal state, so a partial
 *   fill that is still working, an `UNKNOWN` order, and an unconfirmed
 *   cancellation all release exactly nothing.
 *
 * Determinism: this module reads no clock and draws no random number. Time
 * arrives as an `IsoUtcTimestamp` parameter on every operation; fill
 * quantities come from the caller's behavior script or from a hash of
 * (seed, client order id); prices come from the submitted quote and the
 * configured slippage cap. The same configuration driven through the same
 * calls with the same timestamps produces byte-identical records.
 *
 * There is no network client, no credential parameter, and no base URL in
 * this package — not disabled, absent. `no-live-endpoint.test.ts` asserts
 * that at the source level so it stays absent.
 */

const BASIS_POINT_DIVISOR = 10_000n;

export type PaperExchangeConfig = {
  /** Seeds the deterministic fill split; the same seed always yields the same fills. */
  readonly seed: number;
  /** Decimal places the venue quotes and settles money in. */
  readonly moneyScale: number;
  /** Decimal places the venue accepts a quantity in. */
  readonly quantityScale: number;
  /** Venue fee, in basis points of an execution's notional. Rounded up, always. */
  readonly feeBasisPoints: number;
  /**
   * The worst price movement against the caller the venue will apply,
   * in basis points of the quoted price. It is a cap, not a draw: every
   * execution fills at exactly this adjusted price, so the submission-time
   * envelope check can prove no fill can breach the intent's `maxSpend` or
   * `minAcceptableReceipt`.
   */
  readonly slippageBasisPoints: number;
  /** Applied to any client order id `behaviors` does not name. */
  readonly defaultBehavior?: VenueBehavior;
  /** Per-client-order-id fault script. */
  readonly behaviors?: Readonly<Record<string, VenueBehavior>>;
  /** Default coverage for `readVenueState`; a call may override it. */
  readonly reconciliationCoverage?: ReconciliationCoverage;
};

export type SubmitOrderRequest = {
  /** Must be in `RESERVED`: capital is reserved before anything is submitted. */
  readonly order: PaperOrder;
  /** Untrusted: parsed and freshness-checked through `@vigil/market`. */
  readonly quote: unknown;
  readonly now: IsoUtcTimestamp;
};

export type SubmitOrderResult =
  | { readonly outcome: "ACKNOWLEDGED"; readonly order: PaperOrder }
  /** The response was lost. The order is `UNKNOWN` and only reconciliation resolves it. */
  | { readonly outcome: "UNKNOWN"; readonly order: PaperOrder }
  | { readonly outcome: "REJECTED"; readonly order: PaperOrder; readonly detail: string }
  | { readonly outcome: "EXPIRED"; readonly order: PaperOrder; readonly detail: string }
  /** Nothing was submitted and the caller's order is unchanged. */
  | { readonly outcome: "REFUSED"; readonly refusal: PaperRefusal };

export type PollOrderRequest = {
  readonly order: PaperOrder;
  readonly now: IsoUtcTimestamp;
};

export type PollOrderResult =
  | { readonly outcome: "UPDATED"; readonly order: PaperOrder; readonly newExecutions: readonly OrderExecution[] }
  | { readonly outcome: "UNCHANGED"; readonly order: PaperOrder }
  | { readonly outcome: "REFUSED"; readonly refusal: PaperRefusal };

export type CancelOrderRequest = {
  readonly order: PaperOrder;
  readonly now: IsoUtcTimestamp;
};

export type CancelOrderResult =
  | { readonly outcome: "CANCELED"; readonly order: PaperOrder }
  /** The cancellation response was lost; the order rests at `CANCEL_PENDING`. */
  | { readonly outcome: "UNKNOWN"; readonly order: PaperOrder }
  | { readonly outcome: "REFUSED"; readonly refusal: PaperRefusal };

export type ReadVenueStateRequest = {
  readonly now: IsoUtcTimestamp;
  readonly coverage?: ReconciliationCoverage;
};

/** The venue's own answer about one order. Not derived from any caller record. */
export type VenueOrderView = {
  readonly venueOrderId: string;
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly state: OrderState;
  readonly quantity: DecimalString;
  readonly filledQuantity: DecimalString;
  readonly unfilledQuantity: DecimalString;
  readonly grossNotional: DecimalString;
  readonly feesPaid: DecimalString;
  readonly acceptedAt: IsoUtcTimestamp;
  readonly closedAt: IsoUtcTimestamp | null;
  readonly executions: readonly OrderExecution[];
};

export type VenueReconciliationReport = {
  readonly asOf: IsoUtcTimestamp;
  readonly coverage: ReconciliationCoverage;
  readonly capabilityVersion: string;
  /** Orders the venue still holds working. */
  readonly openOrders: readonly VenueOrderView[];
  /** Orders the venue has closed, with the outcome it closed them at. */
  readonly closedOrders: readonly VenueOrderView[];
  /** Every execution the venue has produced, across every order. */
  readonly executions: readonly OrderExecution[];
};

export type ReconcileOrderRequest = {
  /** Must be `UNKNOWN` or `CANCEL_PENDING` — the two unconfirmed states. */
  readonly order: PaperOrder;
  readonly report: VenueReconciliationReport;
  readonly now: IsoUtcTimestamp;
};

export type ReconcileOrderResult =
  | { readonly outcome: "RESOLVED"; readonly order: PaperOrder }
  /** The read could not settle it. The order is returned unchanged, still unconfirmed. */
  | { readonly outcome: "UNRESOLVED"; readonly order: PaperOrder; readonly refusal: PaperRefusal }
  | { readonly outcome: "REFUSED"; readonly refusal: PaperRefusal };

export type PaperExchange = {
  readonly capability: AdapterCapability;
  submitOrder: (request: SubmitOrderRequest) => SubmitOrderResult;
  pollOrder: (request: PollOrderRequest) => PollOrderResult;
  cancelOrder: (request: CancelOrderRequest) => CancelOrderResult;
  /** The reconciliation read: the venue's own confirmed state, and the only thing that resolves an UNKNOWN. */
  readVenueState: (request: ReadVenueStateRequest) => VenueReconciliationReport;
  reconcileOrder: (request: ReconcileOrderRequest) => ReconcileOrderResult;
};

type PendingExecution = {
  readonly quantityUnits: bigint;
  readonly dueAfterMs: number;
};

type VenueOrderRecord = {
  readonly venueOrderId: string;
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly quantityUnits: bigint;
  readonly priceUnits: bigint;
  readonly acceptedAt: IsoUtcTimestamp;
  state: OrderState;
  filledUnits: bigint;
  notionalUnits: bigint;
  feeUnits: bigint;
  pending: readonly PendingExecution[];
  executions: readonly OrderExecution[];
  closedAt: IsoUtcTimestamp | null;
};

function requireInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`paper exchange configuration: ${name} must be an integer in [${String(min)}, ${String(max)}], got ${String(value)}`);
  }
  return value;
}

/**
 * Builds a simulated exchange. The configuration is call-site
 * configuration, not untrusted input, so a nonsensical value throws rather
 * than producing a diagnostic: a fee of `NaN` basis points is a bug in the
 * harness that built it, and `docs/resilience.md` §4 reserves an exception
 * for exactly that.
 */
export function createPaperExchange(config: PaperExchangeConfig): PaperExchange {
  requireInteger(config.seed, "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const moneyScale = requireInteger(config.moneyScale, "moneyScale", 0, 18);
  const quantityScale = requireInteger(config.quantityScale, "quantityScale", 0, 18);
  const feeBasisPoints = BigInt(requireInteger(config.feeBasisPoints, "feeBasisPoints", 0, 10_000));
  // Strictly under 10 000 bp: a 100% adverse move would drive a sell's
  // execution price to zero, which is not slippage but a different failure.
  const slippageBasisPoints = BigInt(requireInteger(config.slippageBasisPoints, "slippageBasisPoints", 0, 9_999));
  const quantityFactor = scaleFactor(quantityScale);
  const defaultBehavior = config.defaultBehavior ?? ACKNOWLEDGE_AND_FILL;
  const behaviors = config.behaviors ?? {};
  const defaultCoverage: ReconciliationCoverage = config.reconciliationCoverage ?? "COMPLETE";

  const book = new Map<string, VenueOrderRecord>();
  let venueSequence = 0;

  function behaviorFor(clientOrderId: string): VenueBehavior {
    return behaviors[clientOrderId] ?? defaultBehavior;
  }

  function nextVenueOrderId(): string {
    venueSequence += 1;
    return `PAPER-${String(venueSequence).padStart(6, "0")}`;
  }

  /**
   * Moves the VENUE's own record. An illegal move here is a bug in this
   * simulation rather than anything a caller did, so it throws: a paper
   * venue that can walk outside the lifecycle is worse than no paper venue,
   * because every suite built on it would be proving the wrong machine.
   */
  function setVenueState(record: VenueOrderRecord, next: OrderState, at: IsoUtcTimestamp): void {
    if (!isLegalOrderTransition(record.state, next)) {
      throw new Error(`paper venue attempted ${record.state} -> ${next} on ${record.venueOrderId}, which is not in the Exchange lifecycle`);
    }
    record.state = next;
    if (isTerminalOrderState(next)) {
      record.closedAt = at;
    }
  }

  function planPendingExecutions(
    behavior: ExecutionBehavior,
    quantityUnits: bigint,
    clientOrderId: string,
  ): readonly PendingExecution[] {
    switch (behavior.kind) {
      case "NONE":
        return [];
      case "FULL":
        requireInteger(behavior.afterMs, "executions.afterMs", 0, Number.MAX_SAFE_INTEGER);
        return [{ quantityUnits, dueAfterMs: behavior.afterMs }];
      case "STEPS": {
        const pending: PendingExecution[] = [];
        let planned = 0n;
        for (const step of behavior.steps) {
          requireInteger(step.afterMs, "executions.steps[].afterMs", 0, Number.MAX_SAFE_INTEGER);
          const stepUnits = unitsOf(step.quantity, quantityScale);
          if (stepUnits === null || stepUnits <= 0n) {
            throw new Error(`paper exchange configuration: execution step quantity "${step.quantity}" is not a positive quantity at scale ${String(quantityScale)}`);
          }
          planned += stepUnits;
          if (planned > quantityUnits) {
            throw new Error(`paper exchange configuration: execution steps for "${clientOrderId}" sum to more than the order quantity; a venue cannot fill more than it was asked for`);
          }
          pending.push({ quantityUnits: stepUnits, dueAfterMs: step.afterMs });
        }
        return pending;
      }
      case "SEEDED": {
        const stepCount = requireInteger(behavior.stepCount, "executions.stepCount", 1, 1_000);
        const intervalMs = requireInteger(behavior.intervalMs, "executions.intervalMs", 0, Number.MAX_SAFE_INTEGER);
        const parts = splitUnits(quantityUnits, stepCount, `${String(config.seed)}:${clientOrderId}`);
        return parts.map((part, index) => ({ quantityUnits: part, dueAfterMs: (index + 1) * intervalMs }));
      }
    }
  }

  function buildExecution(record: VenueOrderRecord, quantityUnits: bigint, at: IsoUtcTimestamp): OrderExecution {
    // A buyer's notional rounds UP and a seller's proceeds round DOWN, and
    // the fee always rounds UP: every rounding decision in an execution is
    // the one that cannot flatter vigil's own accounting.
    const notionalUnits = mulDiv(quantityUnits, record.priceUnits, quantityFactor, record.side === "BUY" ? "UP" : "DOWN");
    const feeUnits = mulDiv(notionalUnits, feeBasisPoints, BASIS_POINT_DIVISOR, "UP");
    const sequence = record.executions.length + 1;
    return {
      executionId: `${record.venueOrderId}-E${String(sequence).padStart(2, "0")}`,
      reportedAt: at,
      quantity: renderUnits(quantityUnits, quantityScale),
      price: renderUnits(record.priceUnits, moneyScale),
      notional: renderUnits(notionalUnits, moneyScale),
      fee: renderUnits(feeUnits, moneyScale),
    };
  }

  /**
   * Advances the venue's own record to `now` by applying every queued
   * execution that has come due. Called at the start of every operation,
   * including the reconciliation read, so the venue's truth is a function
   * of the timestamps it has been shown and never of the order in which a
   * caller happened to ask.
   */
  function advanceVenue(record: VenueOrderRecord, now: IsoUtcTimestamp): void {
    if (!isLiveOrderState(record.state)) {
      return;
    }
    const elapsedMs = ageMs(record.acceptedAt, now);
    if (Number.isNaN(elapsedMs)) {
      return;
    }

    let applied = false;
    while (record.pending.length > 0) {
      const next = record.pending[0];
      if (next === undefined || next.dueAfterMs > elapsedMs) {
        break;
      }
      record.pending = record.pending.slice(1);
      const execution = buildExecution(record, next.quantityUnits, now);
      record.executions = [...record.executions, execution];
      record.filledUnits += next.quantityUnits;
      const notionalUnits = unitsOf(execution.notional, moneyScale);
      const feeUnits = unitsOf(execution.fee, moneyScale);
      if (notionalUnits === null || feeUnits === null) {
        throw new Error("paper venue rendered an execution it cannot read back at its own money scale");
      }
      record.notionalUnits += notionalUnits;
      record.feeUnits += feeUnits;
      applied = true;
    }

    if (applied) {
      const reached: OrderState = record.filledUnits >= record.quantityUnits ? "FILLED" : "PARTIALLY_FILLED";
      if (reached !== record.state) {
        setVenueState(record, reached, now);
      }
    }

    applyRestingBehavior(record, elapsedMs, now);
  }

  /**
   * Applies a venue-initiated terminal event to a resting order. Executions
   * are applied first, above, because an execution that was already due
   * happened before the venue got round to expiring or cancelling the rest.
   */
  function applyRestingBehavior(record: VenueOrderRecord, elapsedMs: number, now: IsoUtcTimestamp): void {
    const resting: RestingBehavior = behaviorFor(record.clientOrderId).resting ?? { kind: "NONE" };
    if (resting.kind === "NONE" || !isLiveOrderState(record.state) || resting.afterMs > elapsedMs) {
      return;
    }

    switch (resting.kind) {
      case "EXPIRE":
      case "REJECT": {
        // Only from ACKNOWLEDGED: the lifecycle draws no edge from
        // PARTIALLY_FILLED to EXPIRED or REJECTED, and a partially filled
        // order that the venue expires is a real case this machine cannot
        // represent without a documented diagram change.
        if (record.state !== "ACKNOWLEDGED") {
          return;
        }
        record.pending = [];
        setVenueState(record, resting.kind === "EXPIRE" ? "EXPIRED" : "REJECTED", now);
        return;
      }
      case "CANCEL": {
        record.pending = [];
        setVenueState(record, "CANCEL_PENDING", now);
        setVenueState(record, "CANCELED", now);
        return;
      }
    }
  }

  function viewOf(record: VenueOrderRecord): VenueOrderView {
    return {
      venueOrderId: record.venueOrderId,
      clientOrderId: record.clientOrderId,
      side: record.side,
      state: record.state,
      quantity: renderUnits(record.quantityUnits, quantityScale),
      filledQuantity: renderUnits(record.filledUnits, quantityScale),
      unfilledQuantity: renderUnits(record.quantityUnits - record.filledUnits, quantityScale),
      grossNotional: renderUnits(record.notionalUnits, moneyScale),
      feesPaid: renderUnits(record.feeUnits, moneyScale),
      acceptedAt: record.acceptedAt,
      closedAt: record.closedAt,
      executions: record.executions,
    };
  }

  /**
   * Brings a caller's order up to the venue's record without inventing
   * anything: it adopts the executions the caller has not yet seen and,
   * only if the venue's state differs, records the transition. Comparing
   * counts rather than replaying this call's own output means a caller that
   * fell behind — because a different operation advanced the venue first —
   * still catches up rather than silently missing a fill.
   */
  function syncFromVenue(
    order: PaperOrder,
    record: VenueOrderRecord,
    now: IsoUtcTimestamp,
    note: string,
  ): { readonly order: PaperOrder; readonly newExecutions: readonly OrderExecution[]; readonly refusal: PaperRefusal | null } {
    const unseen = record.executions.slice(order.executions.length);
    let working: PaperOrder = {
      ...order,
      venueOrderId: record.venueOrderId,
      executions: [...order.executions, ...unseen],
    };

    if (record.state !== order.state && !isTerminalOrderState(order.state)) {
      const moved = applyOrderTransition(working, record.state, now, note);
      if (!moved.applied) {
        return { order, newExecutions: [], refusal: moved.refusal };
      }
      working = moved.order;
    }

    return { order: working, newExecutions: unseen, refusal: null };
  }

  function submitOrder(request: SubmitOrderRequest): SubmitOrderResult {
    const { order, now } = request;

    if (order.state !== "RESERVED") {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "ORDER_NOT_RESERVED",
          `an order is submitted only from RESERVED — capital is reserved before dispatch (docs/resilience.md §9) — and this one is ${order.state}`,
        ),
      };
    }

    if (order.capabilityVersion !== PAPER_ADAPTER_CAPABILITY_VERSION) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "CAPABILITY_VERSION_MISMATCH",
          `order was proposed against adapter capability "${order.capabilityVersion}"; this adapter implements "${PAPER_ADAPTER_CAPABILITY_VERSION}"`,
        ),
      };
    }

    if (ageMs(order.envelope.validUntil, now) > 0) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "INTENT_EXPIRED",
          `the intent's validity window closed at ${order.envelope.validUntil}, before the supplied time ${now}`,
        ),
      };
    }

    const evaluation = evaluateQuoteFreshness({
      raw: request.quote,
      now,
      maxAgeMs: order.envelope.requiredFreshnessMs,
    });
    if (!evaluation.executable) {
      return {
        outcome: "REFUSED",
        refusal:
          evaluation.reasonCode === "STALE_QUOTE"
            ? policyRefusal("STALE_QUOTE", evaluation.detail)
            : adapterRefusal("QUOTE_UNUSABLE", `quote refused with ${evaluation.reasonCode}: ${evaluation.detail}`),
      };
    }

    const quantityUnits = unitsOf(order.quantity, quantityScale);
    if (quantityUnits === null || quantityUnits <= 0n) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "VENUE_PRECISION_EXCEEDED",
          `quantity "${order.quantity}" is not a positive quantity the venue can hold at scale ${String(quantityScale)}`,
        ),
      };
    }

    const referencePrice = order.side === "BUY" ? evaluation.quote.askPrice : evaluation.quote.bidPrice;
    const referenceUnits = unitsOf(referencePrice, moneyScale);
    if (referenceUnits === null) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "VENUE_PRECISION_EXCEEDED",
          `quoted price "${referencePrice}" carries finer precision than the venue's money scale (${String(moneyScale)})`,
        ),
      };
    }

    const priceUnits =
      order.side === "BUY"
        ? mulDiv(referenceUnits, BASIS_POINT_DIVISOR + slippageBasisPoints, BASIS_POINT_DIVISOR, "UP")
        : mulDiv(referenceUnits, BASIS_POINT_DIVISOR - slippageBasisPoints, BASIS_POINT_DIVISOR, "DOWN");

    // The whole order at the capped price is the worst case the venue can
    // produce, because every execution fills at exactly this price. Proving
    // the worst case fits the approved envelope here is what makes it
    // impossible for any later fill to breach it.
    const worstNotionalUnits = mulDiv(quantityUnits, priceUnits, quantityFactor, order.side === "BUY" ? "UP" : "DOWN");
    const worstFeeUnits = mulDiv(worstNotionalUnits, feeBasisPoints, BASIS_POINT_DIVISOR, "UP");

    if (order.side === "BUY") {
      const worstSpend = renderUnits(worstNotionalUnits + worstFeeUnits, moneyScale);
      if (compareDecimals(worstSpend, order.envelope.maxSpend) > 0) {
        return {
          outcome: "REFUSED",
          refusal: adapterRefusal(
            "MAX_SPEND_EXCEEDED",
            `filling the whole order at the venue's capped price would spend ${worstSpend}, above the approved maxSpend ${order.envelope.maxSpend}`,
          ),
        };
      }
    } else {
      const worstReceipt = renderUnits(worstNotionalUnits - worstFeeUnits, moneyScale);
      if (compareDecimals(worstReceipt, order.envelope.minAcceptableReceipt) < 0) {
        return {
          outcome: "REFUSED",
          refusal: adapterRefusal(
            "RECEIPT_BELOW_MINIMUM",
            `filling the whole order at the venue's capped price would receive ${worstReceipt}, below the approved minAcceptableReceipt ${order.envelope.minAcceptableReceipt}`,
          ),
        };
      }
    }

    const existing = book.get(order.clientOrderId);
    if (existing !== undefined) {
      advanceVenue(existing, now);
      if (isTerminalOrderState(existing.state)) {
        return {
          outcome: "REFUSED",
          refusal: adapterRefusal(
            "IDEMPOTENCY_KEY_ALREADY_USED",
            `the venue already holds ${existing.venueOrderId} under client order id "${order.clientOrderId}", closed at ${existing.state}; an approved intent is consumable exactly once`,
          ),
        };
      }
      return {
        outcome: "REFUSED",
        refusal: policyRefusal(
          "TRANSACTION_UNRESOLVED",
          `the venue is still working ${existing.venueOrderId} under client order id "${order.clientOrderId}" (${existing.state}); reconcile against the venue before any resubmission`,
        ),
      };
    }

    const dispatched = applyOrderTransition(
      order,
      "SUBMITTING",
      now,
      `attempt ${String(order.attempt)} dispatched to the simulated venue`,
    );
    if (!dispatched.applied) {
      return { outcome: "REFUSED", refusal: dispatched.refusal };
    }
    const submitted: PaperOrder = dispatched.order;

    const behavior = behaviorFor(order.clientOrderId);

    function accept(state: OrderState): VenueOrderRecord {
      const record: VenueOrderRecord = {
        venueOrderId: nextVenueOrderId(),
        clientOrderId: order.clientOrderId,
        side: order.side,
        quantityUnits,
        priceUnits,
        acceptedAt: now,
        state,
        filledUnits: 0n,
        notionalUnits: 0n,
        feeUnits: 0n,
        pending: isLiveOrderState(state) ? planPendingExecutions(behavior.executions, quantityUnits, order.clientOrderId) : [],
        executions: [],
        closedAt: isTerminalOrderState(state) ? now : null,
      };
      book.set(order.clientOrderId, record);
      return record;
    }

    switch (behavior.submission.kind) {
      case "ACKNOWLEDGE": {
        const record = accept("ACKNOWLEDGED");
        const acknowledged = applyOrderTransition(submitted, "ACKNOWLEDGED", now, "venue acknowledged the order");
        if (!acknowledged.applied) {
          return { outcome: "REFUSED", refusal: acknowledged.refusal };
        }
        return { outcome: "ACKNOWLEDGED", order: { ...acknowledged.order, venueOrderId: record.venueOrderId } };
      }
      case "TIMEOUT": {
        if (behavior.submission.venueAccepted) {
          accept("ACKNOWLEDGED");
        }
        const unknown = applyOrderTransition(
          submitted,
          "UNKNOWN",
          now,
          "submission timed out; whether the venue accepted the order is not known and is not assumed",
        );
        if (!unknown.applied) {
          return { outcome: "REFUSED", refusal: unknown.refusal };
        }
        // `venueOrderId` stays null even when the venue did accept: the
        // caller observed nothing, and this record must not imply otherwise.
        return { outcome: "UNKNOWN", order: unknown.order };
      }
      case "REJECT": {
        const record = accept("REJECTED");
        const rejected = applyOrderTransition(
          submitted,
          "REJECTED",
          now,
          `venue confirmed a rejection: ${behavior.submission.detail}`,
        );
        if (!rejected.applied) {
          return { outcome: "REFUSED", refusal: rejected.refusal };
        }
        return {
          outcome: "REJECTED",
          order: { ...rejected.order, venueOrderId: record.venueOrderId },
          detail: behavior.submission.detail,
        };
      }
      case "EXPIRE": {
        const record = accept("EXPIRED");
        const expired = applyOrderTransition(
          submitted,
          "EXPIRED",
          now,
          `venue confirmed an expiry: ${behavior.submission.detail}`,
        );
        if (!expired.applied) {
          return { outcome: "REFUSED", refusal: expired.refusal };
        }
        return {
          outcome: "EXPIRED",
          order: { ...expired.order, venueOrderId: record.venueOrderId },
          detail: behavior.submission.detail,
        };
      }
    }
  }

  function liveRecordFor(order: PaperOrder, now: IsoUtcTimestamp, operation: string): VenueOrderRecord | PaperRefusal {
    if (order.state === "UNKNOWN" || order.state === "CANCEL_PENDING") {
      return adapterRefusal(
        "RECONCILIATION_REQUIRED",
        `${operation} is not available on an order in ${order.state}; reconciliation against the venue's own state comes first (docs/resilience.md §3)`,
      );
    }
    if (isTerminalOrderState(order.state)) {
      return adapterRefusal("ORDER_ALREADY_TERMINAL", `the order is ${order.state}; nothing further happens to it`);
    }
    if (!isLiveOrderState(order.state)) {
      return adapterRefusal(
        "ORDER_NOT_LIVE",
        `${operation} needs an order the venue is working; this one is ${order.state}`,
      );
    }
    const record = book.get(order.clientOrderId);
    if (record === undefined) {
      return adapterRefusal(
        "VENUE_ORDER_NOT_FOUND",
        `the venue holds no order under client order id "${order.clientOrderId}"`,
      );
    }
    advanceVenue(record, now);
    return record;
  }

  function isRefusal(value: VenueOrderRecord | PaperRefusal): value is PaperRefusal {
    return "reason" in value;
  }

  function pollOrder(request: PollOrderRequest): PollOrderResult {
    const found = liveRecordFor(request.order, request.now, "polling");
    if (isRefusal(found)) {
      return { outcome: "REFUSED", refusal: found };
    }

    const synced = syncFromVenue(request.order, found, request.now, `venue reports ${found.state}`);
    if (synced.refusal !== null) {
      return { outcome: "REFUSED", refusal: synced.refusal };
    }
    if (synced.newExecutions.length === 0 && synced.order.state === request.order.state) {
      return { outcome: "UNCHANGED", order: synced.order };
    }
    return { outcome: "UPDATED", order: synced.order, newExecutions: synced.newExecutions };
  }

  function cancelOrder(request: CancelOrderRequest): CancelOrderResult {
    const found = liveRecordFor(request.order, request.now, "cancellation");
    if (isRefusal(found)) {
      return { outcome: "REFUSED", refusal: found };
    }

    if (isTerminalOrderState(found.state)) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "ORDER_ALREADY_TERMINAL",
          `the venue order reached ${found.state} before the cancellation arrived; poll the order to take up its executions before deciding what to do`,
        ),
      };
    }

    const synced = syncFromVenue(request.order, found, request.now, `venue reports ${found.state} as the cancellation is requested`);
    if (synced.refusal !== null) {
      return { outcome: "REFUSED", refusal: synced.refusal };
    }

    // Whatever has not executed by now is what the cancellation releases.
    // Everything already executed stays executed: filled exposure and its
    // fees persist through a cancellation (docs/resilience.md §3).
    found.pending = [];
    setVenueState(found, "CANCEL_PENDING", request.now);

    const requested = applyOrderTransition(synced.order, "CANCEL_PENDING", request.now, "cancellation requested at the venue");
    if (!requested.applied) {
      return { outcome: "REFUSED", refusal: requested.refusal };
    }

    // The venue cancels either way. The fault is whether the caller gets to
    // hear about it.
    setVenueState(found, "CANCELED", request.now);

    const behavior = behaviorFor(request.order.clientOrderId);
    if (behavior.cancellation.kind === "TIMEOUT") {
      return { outcome: "UNKNOWN", order: requested.order };
    }

    const canceled = applyOrderTransition(requested.order, "CANCELED", request.now, "venue confirmed the cancellation");
    if (!canceled.applied) {
      return { outcome: "REFUSED", refusal: canceled.refusal };
    }
    return { outcome: "CANCELED", order: canceled.order };
  }

  function readVenueState(request: ReadVenueStateRequest): VenueReconciliationReport {
    const openOrders: VenueOrderView[] = [];
    const closedOrders: VenueOrderView[] = [];
    const executions: OrderExecution[] = [];

    for (const record of book.values()) {
      advanceVenue(record, request.now);
      const view = viewOf(record);
      if (isTerminalOrderState(record.state)) {
        closedOrders.push(view);
      } else {
        openOrders.push(view);
      }
      executions.push(...record.executions);
    }

    return {
      asOf: request.now,
      coverage: request.coverage ?? defaultCoverage,
      capabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
      openOrders,
      closedOrders,
      executions,
    };
  }

  function reconcileOrder(request: ReconcileOrderRequest): ReconcileOrderResult {
    const { order, report, now } = request;

    if (order.state !== "UNKNOWN" && order.state !== "CANCEL_PENDING") {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "RECONCILIATION_NOT_APPLICABLE",
          `only an UNKNOWN or CANCEL_PENDING order is awaiting reconciliation; this one is ${order.state}`,
        ),
      };
    }

    if (report.capabilityVersion !== PAPER_ADAPTER_CAPABILITY_VERSION) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "CAPABILITY_VERSION_MISMATCH",
          `the reconciliation read was produced by adapter capability "${report.capabilityVersion}"; this adapter implements "${PAPER_ADAPTER_CAPABILITY_VERSION}"`,
        ),
      };
    }

    const view =
      report.openOrders.find((candidate) => candidate.clientOrderId === order.clientOrderId) ??
      report.closedOrders.find((candidate) => candidate.clientOrderId === order.clientOrderId);

    if (view === undefined) {
      if (report.coverage === "INCOMPLETE") {
        return {
          outcome: "UNRESOLVED",
          order,
          refusal: adapterRefusal(
            "RECONCILIATION_INCOMPLETE",
            "the read did not cover the whole venue, so this order's absence from it confirms nothing; it stays unresolved",
          ),
        };
      }
      if (order.state === "CANCEL_PENDING") {
        return {
          outcome: "UNRESOLVED",
          order,
          refusal: adapterRefusal(
            "RECONCILIATION_CONTRADICTION",
            "an order awaiting a cancellation confirmation is missing from an authoritative venue read; that contradiction is not resolved by guessing",
          ),
        };
      }
      const rejected = applyOrderTransition(
        order,
        "REJECTED",
        now,
        "reconciliation: an authoritative venue read holds no order under this client order id, confirming the venue never accepted it",
      );
      if (!rejected.applied) {
        return { outcome: "UNRESOLVED", order, refusal: rejected.refusal };
      }
      return { outcome: "RESOLVED", order: rejected.order };
    }

    const adopted: PaperOrder = {
      ...order,
      venueOrderId: view.venueOrderId,
      executions: view.executions,
    };
    const resolved = applyOrderTransition(
      adopted,
      view.state,
      now,
      `reconciliation: the venue confirms ${view.state} for ${view.venueOrderId}`,
    );
    if (!resolved.applied) {
      return {
        outcome: "UNRESOLVED",
        order,
        refusal: adapterRefusal(
          "RECONCILIATION_CONTRADICTION",
          `the venue reports ${view.state}, which cannot follow ${order.state} in the Exchange lifecycle; the order stays unresolved rather than being forced`,
        ),
      };
    }
    return { outcome: "RESOLVED", order: resolved.order };
  }

  return {
    capability: PAPER_ADAPTER_CAPABILITY,
    submitOrder,
    pollOrder,
    cancelOrder,
    readVenueState,
    reconcileOrder,
  };
}
