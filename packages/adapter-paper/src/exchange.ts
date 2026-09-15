import { ageMs } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";
import { evaluateQuoteFreshness } from "@vigil/market";
import type { QuoteSnapshot } from "@vigil/market";

import { PAPER_ADAPTER_CAPABILITY, PAPER_ADAPTER_CAPABILITY_VERSION } from "./capability";
import type { AdapterCapability } from "./capability";
import { adapterRefusal, policyRefusal } from "./diagnostics";
import type { PaperRefusal } from "./diagnostics";
import { cumulativeFeeUnits, cumulativeNotionalUnits, worstCaseEconomics } from "./execution-economics";
import type { VenuePricing } from "./execution-economics";
import { ACKNOWLEDGE_AND_FILL } from "./faults";
import type { ExecutionBehavior, ReconciliationCoverage, RestingBehavior, VenueBehavior } from "./faults";
import type { OrderSide } from "./intent";
import { applyOrderTransition } from "./order";
import type { OrderExecution, PaperOrder } from "./order";
import {
  CONFIRMED_VENUE_STATES,
  isLegalOrderTransition,
  isLiveOrderState,
  isTerminalOrderState,
  orderTransitionPath,
} from "./order-state";
import type { OrderState } from "./order-state";
import { compareDecimals, mulDiv, renderUnits, splitUnits, unitsOf } from "./venue-math";

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
 * - Re-dispatching an intent the venue may already hold is REFUSED, not
 *   deduplicated. Two guards, because one is not enough: the order book
 *   catches a client order id the venue accepted, and a private set of
 *   dispatched ids catches the case where the venue accepted NOTHING, where
 *   the book is empty and the caller still holds its untouched `RESERVED`
 *   order and could simply submit it again. Both refuse before any quote or
 *   envelope check, so the caller is told to reconcile rather than told to
 *   refresh its quote.
 * - Nothing is released on an unsettled order. `settlementOf` reports
 *   `releasableRemainder: null` for every non-terminal state, so a partial
 *   fill that is still working, an `UNKNOWN` order, and an unconfirmed
 *   cancellation all release exactly nothing.
 * - The caller can always catch up with the venue. When the venue moved two
 *   documented steps at once — a venue-initiated cancellation takes a
 *   resting order `ACKNOWLEDGED -> CANCEL_PENDING -> CANCELED` — the caller
 *   is walked along the same route rather than being offered a jump that is
 *   not in the table and then wedged when it is refused.
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
  /** Venue fee, in basis points of the cumulative notional. Rounded up, always. */
  readonly feeBasisPoints: number;
  /**
   * The worst price movement against the caller the venue will apply, in
   * basis points of the quoted executable price. It is a cap, not a draw:
   * every execution fills at exactly this adjusted price.
   */
  readonly slippageBasisPoints: number;
  /**
   * A flat cost the fixture charges once per order that actually produced a
   * fill — a modeled network or transaction cost. Zero is valid and is the
   * default for an exchange fixture. It is charged only when something
   * filled: a cancellation invents no cost on the unfilled remainder
   * (issue #33, "Explicit execution economics").
   */
  readonly fixedExecutionCost?: DecimalString;
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
  /**
   * Refused — and the caller's order comes back anyway, carrying any
   * executions the venue had reported but the caller had not yet seen. The
   * STATE is never advanced on this path. An execution is a fact about money
   * that already moved, so it is handed over even when the state cannot be
   * reconciled; losing it would leave real exposure invisible.
   */
  | { readonly outcome: "REFUSED"; readonly order: PaperOrder; readonly refusal: PaperRefusal };

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
  /**
   * Venue-initiated events the lifecycle had no edge for by the time they
   * came due, so the venue did not apply them. Reported rather than dropped
   * silently: a scenario that scheduled one needs to know it did not happen.
   */
  readonly droppedVenueEvents: readonly string[];
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
  /** Must be a report this exchange issued; a hand-built one authorizes nothing. */
  readonly report: VenueReconciliationReport;
  readonly now: IsoUtcTimestamp;
};

/**
 * Why an order resolved the way it did. `REJECTED` reached through
 * `VENUE_HELD_NO_RECORD` and `REJECTED` reached through `VENUE_CONFIRMED`
 * are the same state and different facts: a venue that rejected an order may
 * reject it again and the intent should not be re-dispatched blindly, while
 * an order the venue never received is safe to dispatch again once the
 * intent is re-validated. The distinction has to survive in something code
 * can switch on, not only in a note a human reads.
 */
export const RESOLUTION_BASES = ["VENUE_CONFIRMED", "VENUE_HELD_NO_RECORD"] as const;

export type ResolutionBasis = (typeof RESOLUTION_BASES)[number];

export type ReconcileOrderResult =
  | { readonly outcome: "RESOLVED"; readonly order: PaperOrder; readonly resolution: ResolutionBasis }
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
  readonly pricing: VenuePricing;
  readonly acceptedAt: IsoUtcTimestamp;
  state: OrderState;
  filledUnits: bigint;
  notionalUnits: bigint;
  feeUnits: bigint;
  pending: readonly PendingExecution[];
  executions: readonly OrderExecution[];
  closedAt: IsoUtcTimestamp | null;
  restingEventSettled: boolean;
  droppedVenueEvents: readonly string[];
};

function requireInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`paper exchange configuration: ${name} must be an integer in [${String(min)}, ${String(max)}], got ${String(value)}`);
  }
  return value;
}

/**
 * Concrete union rather than a structural `{ reason?: unknown }` shape: a
 * parameter type whose properties are all optional is a "weak type", and
 * TypeScript rejects passing it a record that shares no property with it —
 * which is every `VenueOrderRecord` and every `VenuePricing`.
 */
function isRefusal(value: VenueOrderRecord | VenuePricing | PaperRefusal): value is PaperRefusal {
  return "reason" in value;
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
  const feeBasisPoints = requireInteger(config.feeBasisPoints, "feeBasisPoints", 0, 10_000);
  // Strictly under 10 000 bp: a 100% adverse move would drive a sell's
  // execution price to zero, which is not slippage but a different failure.
  const slippageBasisPoints = requireInteger(config.slippageBasisPoints, "slippageBasisPoints", 0, 9_999);
  const defaultBehavior = config.defaultBehavior ?? ACKNOWLEDGE_AND_FILL;
  const behaviors = config.behaviors ?? {};
  const defaultCoverage: ReconciliationCoverage = config.reconciliationCoverage ?? "COMPLETE";

  const fixedExecutionCost = config.fixedExecutionCost ?? renderUnits(0n, moneyScale);
  const fixedExecutionCostUnits = unitsOf(fixedExecutionCost, moneyScale);
  if (fixedExecutionCostUnits === null || fixedExecutionCostUnits < 0n) {
    throw new Error(
      `paper exchange configuration: fixedExecutionCost "${fixedExecutionCost}" must be a non-negative amount the venue can hold at money scale ${String(moneyScale)}`,
    );
  }

  const book = new Map<string, VenueOrderRecord>();
  /**
   * Client order ids this exchange has dispatched, whatever came back. The
   * book alone cannot be the consumable-once guard: a submission the venue
   * never accepted leaves no book entry, and `PaperOrder` is immutable, so
   * the caller still holds its pre-submission `RESERVED` order and could
   * dispatch it again without ever reconciling — the blind retry after
   * UNKNOWN that `docs/architecture.md` forbids. An id leaves this set only
   * when an authoritative read confirms the venue holds nothing under it.
   */
  const dispatched = new Set<string>();
  /**
   * Reports this instance issued, held by object identity. `reconcileOrder`
   * takes the venue's state from `book`, never from the report's rows, and
   * accepts only a report that came from here — so neither a hand-built
   * report nor one mutated after it was taken can inject a fill that never
   * happened. A `WeakSet` because a report is the caller's to discard.
   */
  const issuedReports = new WeakSet<VenueReconciliationReport>();
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

  /**
   * Fixes this order's economics from the quote it was submitted against.
   *
   * The midpoint is rounded per side — down for a buy, up for a sell —
   * because the spread cost is measured against it, and rounding it the
   * other way would understate what crossing the book cost. The crossed-book
   * refusal above guarantees the midpoint sits between bid and ask, which is
   * what makes both the spread and the slippage components non-negative.
   */
  function derivePricing(side: OrderSide, quote: QuoteSnapshot): VenuePricing | PaperRefusal {
    const bidUnits = unitsOf(quote.bidPrice, moneyScale);
    const askUnits = unitsOf(quote.askPrice, moneyScale);
    if (bidUnits === null || askUnits === null) {
      return adapterRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `quoted prices ("${quote.bidPrice}" / "${quote.askPrice}") carry finer precision than the venue's money scale (${String(moneyScale)})`,
      );
    }
    if (askUnits < bidUnits) {
      return adapterRefusal(
        "CROSSED_QUOTE_BOOK",
        `the quote's ask (${quote.askPrice}) is below its bid (${quote.bidPrice}); a crossed book is corrupt market state and blocks new risk (docs/resilience.md §1)`,
      );
    }

    const referenceUnits = side === "BUY" ? askUnits : bidUnits;
    const midUnits = side === "BUY" ? (bidUnits + askUnits) / 2n : (bidUnits + askUnits + 1n) / 2n;
    const slippage = BigInt(slippageBasisPoints);
    const executionUnits =
      side === "BUY"
        ? mulDiv(referenceUnits, BASIS_POINT_DIVISOR + slippage, BASIS_POINT_DIVISOR, "UP")
        : mulDiv(referenceUnits, BASIS_POINT_DIVISOR - slippage, BASIS_POINT_DIVISOR, "DOWN");

    return {
      moneyScale,
      quantityScale,
      feeBasisPoints,
      slippageBasisPoints,
      referenceBid: quote.bidPrice,
      referenceAsk: quote.askPrice,
      referenceMid: renderUnits(midUnits, moneyScale),
      referencePrice: renderUnits(referenceUnits, moneyScale),
      executionPrice: renderUnits(executionUnits, moneyScale),
      fixedExecutionCost,
    };
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

  type BuiltExecution = {
    readonly execution: OrderExecution;
    readonly cumulativeNotional: bigint;
    readonly cumulativeFee: bigint;
    readonly cumulativeFilled: bigint;
  };

  /**
   * Derives one execution as the INCREMENT of an exact cumulative total, not
   * as an independently rounded product of its own quantity. See
   * `execution-economics.ts` invariant 1: rounding each execution on its own
   * makes the sum strictly exceed the same quantity filled at once, which
   * silently carried a fill past the `maxSpend` the submission check had
   * approved. Reading a fill, this means two executions of equal quantity may
   * carry different notionals and an execution may carry a zero fee — each
   * reports its own increment, and the increments add up exactly.
   */
  function buildExecution(record: VenueOrderRecord, quantityUnits: bigint, at: IsoUtcTimestamp): BuiltExecution {
    const cumulativeFilled = record.filledUnits + quantityUnits;
    const cumulativeNotional = cumulativeNotionalUnits(record.pricing, record.side, cumulativeFilled);
    const cumulativeFee = cumulativeFeeUnits(record.pricing, cumulativeNotional);
    const sequence = record.executions.length + 1;
    return {
      execution: {
        executionId: `${record.venueOrderId}-E${String(sequence).padStart(2, "0")}`,
        reportedAt: at,
        quantity: renderUnits(quantityUnits, quantityScale),
        price: record.pricing.executionPrice,
        notional: renderUnits(cumulativeNotional - record.notionalUnits, moneyScale),
        fee: renderUnits(cumulativeFee - record.feeUnits, moneyScale),
      },
      cumulativeNotional,
      cumulativeFee,
      cumulativeFilled,
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
      const built = buildExecution(record, next.quantityUnits, now);
      record.executions = [...record.executions, built.execution];
      record.filledUnits = built.cumulativeFilled;
      record.notionalUnits = built.cumulativeNotional;
      record.feeUnits = built.cumulativeFee;
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
    if (
      resting.kind === "NONE" ||
      record.restingEventSettled ||
      !isLiveOrderState(record.state) ||
      resting.afterMs > elapsedMs
    ) {
      return;
    }

    switch (resting.kind) {
      case "EXPIRE":
      case "REJECT": {
        const target: OrderState = resting.kind === "EXPIRE" ? "EXPIRED" : "REJECTED";
        if (record.state !== "ACKNOWLEDGED") {
          // The lifecycle draws no edge from PARTIALLY_FILLED to EXPIRED or
          // REJECTED, so the event cannot be applied without inventing one.
          // It is recorded rather than dropped in silence: a scenario that
          // scheduled a venue expiry against an order that filled first would
          // otherwise pass while having simulated nothing.
          record.restingEventSettled = true;
          record.droppedVenueEvents = [
            ...record.droppedVenueEvents,
            `venue ${resting.kind} due at +${String(resting.afterMs)}ms was not applied: the order was ${record.state}, and the Exchange lifecycle draws no edge from it to ${target}`,
          ];
          return;
        }
        record.pending = [];
        record.restingEventSettled = true;
        setVenueState(record, target, now);
        return;
      }
      case "CANCEL": {
        // Legal from both ACKNOWLEDGED and PARTIALLY_FILLED, and it runs
        // through CANCEL_PENDING exactly as a requested cancellation does.
        record.pending = [];
        record.restingEventSettled = true;
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
      droppedVenueEvents: record.droppedVenueEvents,
    };
  }

  type SyncResult = {
    readonly order: PaperOrder;
    readonly newExecutions: readonly OrderExecution[];
    readonly refusal: PaperRefusal | null;
  };

  /**
   * Brings a caller's order up to the venue's record without inventing
   * anything: it adopts the executions the caller has not yet seen and then
   * walks the caller along the documented route to the venue's state, one
   * recorded transition per step.
   *
   * Walking rather than jumping is what keeps a venue-initiated cancellation
   * from wedging the order. The venue takes a resting order
   * `ACKNOWLEDGED -> CANCEL_PENDING -> CANCELED` in one go; a caller offered
   * only the direct `ACKNOWLEDGED -> CANCELED` jump is refused, because the
   * lifecycle does not draw it, and then no operation can advance the order
   * ever again — its capital is never released and its fills are invisible.
   * Every state walked through is one the venue genuinely passed through.
   *
   * The executions are adopted even when the walk fails, and the caller gets
   * them back on the refusal path: an execution is money that already moved.
   */
  function syncFromVenue(order: PaperOrder, record: VenueOrderRecord, now: IsoUtcTimestamp): SyncResult {
    const unseen = record.executions.slice(order.executions.length);
    let working: PaperOrder = {
      ...order,
      venueOrderId: record.venueOrderId,
      executions: [...order.executions, ...unseen],
    };

    if (isTerminalOrderState(order.state)) {
      return { order: working, newExecutions: unseen, refusal: null };
    }

    // Where the caller has to get to, in order. When executions are being
    // adopted, the fill state they imply comes FIRST even if a shorter route
    // to the venue's current state exists: an order that partially filled and
    // was then cancelled genuinely passed through PARTIALLY_FILLED, and a
    // history that jumped straight to CANCELED would leave no trace that it
    // ever held exposure. The executions are adopted either way; this is
    // about the record being readable afterwards.
    const waypoints: OrderState[] = [];
    if (unseen.length > 0) {
      waypoints.push(record.filledUnits >= record.quantityUnits ? "FILLED" : "PARTIALLY_FILLED");
    }
    waypoints.push(record.state);

    for (const waypoint of waypoints) {
      if (waypoint === working.state) {
        continue;
      }
      const path = orderTransitionPath(working.state, waypoint);
      if (path === null) {
        return {
          order: working,
          newExecutions: unseen,
          refusal: adapterRefusal(
            "RECONCILIATION_CONTRADICTION",
            `the venue reports ${record.state}, which the Exchange lifecycle cannot reach from ${working.state} by any route; the order is not forced`,
          ),
        };
      }
      for (const step of path) {
        const note =
          step === record.state
            ? `venue reports ${step}`
            : `venue passed through ${step} on its way to ${record.state}`;
        const moved = applyOrderTransition(working, step, now, note);
        if (!moved.applied) {
          return { order: working, newExecutions: unseen, refusal: moved.refusal };
        }
        working = moved.order;
      }
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

    // Both consumable-once guards run BEFORE the quote and envelope checks.
    // A caller re-dispatching an unresolved intent must be told to reconcile,
    // not told its quote went stale — the second answer invites it to refresh
    // the quote and try again, which is the blind retry the first answer
    // exists to prevent.
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

    if (dispatched.has(order.clientOrderId)) {
      return {
        outcome: "REFUSED",
        refusal: policyRefusal(
          "TRANSACTION_UNRESOLVED",
          `client order id "${order.clientOrderId}" was already dispatched and its outcome has not been resolved against an authoritative venue read; reconciliation precedes resubmission (docs/architecture.md "Execution lifecycles")`,
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
            : // Unreachable against @vigil/market as it stands — every
              // non-executable evaluation it returns carries STALE_QUOTE —
              // and kept so a future reason code from that gate is surfaced
              // honestly rather than relabelled as staleness.
              adapterRefusal("QUOTE_UNUSABLE", `quote refused with ${evaluation.reasonCode}: ${evaluation.detail}`),
      };
    }

    // Schema and freshness say the quote is well-formed and current; neither
    // says it prices THIS order's assets. An instrument id is exactly
    // `baseAssetId/quoteAssetId`, so the pair the order names derives the id
    // its quote must carry — identity re-validated after parsing, which is
    // what docs/resilience.md §5 asks for.
    const expectedInstrumentId =
      order.side === "BUY"
        ? `${order.outputAssetId}/${order.inputAssetId}`
        : `${order.inputAssetId}/${order.outputAssetId}`;
    if (evaluation.quote.instrumentId !== expectedInstrumentId) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "QUOTE_INSTRUMENT_MISMATCH",
          `the quote prices "${evaluation.quote.instrumentId}" but this ${order.side} order trades "${expectedInstrumentId}"; a quote for another instrument never prices this order`,
        ),
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

    const priced = derivePricing(order.side, evaluation.quote);
    if (isRefusal(priced)) {
      return { outcome: "REFUSED", refusal: priced };
    }

    // Every execution fills at `priced.executionPrice` and every total is
    // computed on the CUMULATIVE quantity, so filling the whole order is a
    // genuine upper bound on what any pattern of executions can consume.
    // That is what makes this check a proof rather than an estimate.
    const worstCase = worstCaseEconomics(priced, order.side, quantityUnits);

    if (order.side === "BUY") {
      const worstSpend = renderUnits(worstCase.spendUnits, moneyScale);
      if (compareDecimals(worstSpend, order.envelope.maxSpend) > 0) {
        return {
          outcome: "REFUSED",
          refusal: adapterRefusal(
            "MAX_SPEND_EXCEEDED",
            `filling the whole order at the venue's capped price would spend ${worstSpend} including fees and fixed costs, above the approved maxSpend ${order.envelope.maxSpend}`,
          ),
        };
      }
    } else {
      const worstReceipt = renderUnits(worstCase.receiptUnits, moneyScale);
      if (compareDecimals(worstReceipt, order.envelope.minAcceptableReceipt) < 0) {
        return {
          outcome: "REFUSED",
          refusal: adapterRefusal(
            "RECEIPT_BELOW_MINIMUM",
            `filling the whole order at the venue's capped price would receive ${worstReceipt} net of fees and fixed costs, below the approved minAcceptableReceipt ${order.envelope.minAcceptableReceipt}`,
          ),
        };
      }
    }

    const dispatchedOrder = applyOrderTransition(
      order,
      "SUBMITTING",
      now,
      `attempt ${String(order.attempt)} dispatched to the simulated venue`,
    );
    if (!dispatchedOrder.applied) {
      return { outcome: "REFUSED", refusal: dispatchedOrder.refusal };
    }
    const submitted: PaperOrder = { ...dispatchedOrder.order, pricing: priced };
    dispatched.add(order.clientOrderId);

    const behavior = behaviorFor(order.clientOrderId);

    function accept(state: OrderState): VenueOrderRecord {
      const record: VenueOrderRecord = {
        venueOrderId: nextVenueOrderId(),
        clientOrderId: order.clientOrderId,
        side: order.side,
        quantityUnits,
        pricing: priced,
        acceptedAt: now,
        state,
        filledUnits: 0n,
        notionalUnits: 0n,
        feeUnits: 0n,
        pending: isLiveOrderState(state) ? planPendingExecutions(behavior.executions, quantityUnits, order.clientOrderId) : [],
        executions: [],
        closedAt: isTerminalOrderState(state) ? now : null,
        restingEventSettled: false,
        droppedVenueEvents: [],
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

  function pollOrder(request: PollOrderRequest): PollOrderResult {
    const found = liveRecordFor(request.order, request.now, "polling");
    if (isRefusal(found)) {
      return { outcome: "REFUSED", order: request.order, refusal: found };
    }

    const synced = syncFromVenue(request.order, found, request.now);
    if (synced.refusal !== null) {
      return { outcome: "REFUSED", order: synced.order, refusal: synced.refusal };
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
          `the venue order reached ${found.state} before the cancellation arrived; poll the order to take up its executions and its final state before deciding what to do`,
        ),
      };
    }

    const synced = syncFromVenue(request.order, found, request.now);
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

    const report: VenueReconciliationReport = {
      asOf: request.now,
      coverage: request.coverage ?? defaultCoverage,
      capabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
      openOrders,
      closedOrders,
      executions,
    };
    issuedReports.add(report);
    return report;
  }

  function reconcileOrder(request: ReconcileOrderRequest): ReconcileOrderResult {
    const { order, report, now } = request;

    if (!issuedReports.has(report)) {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "RECONCILIATION_REPORT_UNRECOGNIZED",
          "this reconciliation read was not issued by this exchange; a report the venue did not produce authorizes nothing, least of all a fill",
        ),
      };
    }

    if (order.state !== "UNKNOWN" && order.state !== "CANCEL_PENDING") {
      return {
        outcome: "REFUSED",
        refusal: adapterRefusal(
          "RECONCILIATION_NOT_APPLICABLE",
          `only an UNKNOWN or CANCEL_PENDING order is awaiting reconciliation; this one is ${order.state}`,
        ),
      };
    }

    // The venue's own book, not the report's rows. The report says how much
    // of the venue the read could see and when it was taken; the state comes
    // from the venue itself, so a report mutated after it was taken cannot
    // introduce an order, a state, or an execution.
    const record = book.get(order.clientOrderId);
    if (record === undefined) {
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
      // The venue holds nothing under this id, confirmed. The intent may be
      // dispatched again as a fresh versioned attempt, so the dispatch guard
      // is lifted — and only here, where an authoritative read said so.
      dispatched.delete(order.clientOrderId);
      return { outcome: "RESOLVED", order: rejected.order, resolution: "VENUE_HELD_NO_RECORD" };
    }

    advanceVenue(record, now);

    if (order.state === "UNKNOWN" && !CONFIRMED_VENUE_STATES.includes(record.state)) {
      return {
        outcome: "UNRESOLVED",
        order,
        refusal: adapterRefusal(
          "RECONCILIATION_CONTRADICTION",
          `the venue reports ${record.state}, which is not a confirmed outcome; reconciliation resolves an UNKNOWN order only to a state the venue has actually settled on`,
        ),
      };
    }

    const synced = syncFromVenue(order, record, now);
    if (synced.refusal !== null) {
      return { outcome: "UNRESOLVED", order, refusal: synced.refusal };
    }
    return { outcome: "RESOLVED", order: synced.order, resolution: "VENUE_CONFIRMED" };
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
