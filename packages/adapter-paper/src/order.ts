import { decimalStringSchema } from "@vigil/contracts";
import type { AssetId, DecimalString, IsoUtcTimestamp } from "@vigil/contracts";

import { PAPER_ADAPTER_CAPABILITY_VERSION } from "./capability";
import { adapterRefusal } from "./diagnostics";
import type { PaperRefusal } from "./diagnostics";
import { computeExecutionEconomics } from "./execution-economics";
import type { ExecutionEconomics, VenuePricing } from "./execution-economics";
import { ACTION_ORDER_SIDES, approvedOrderIntentSchema } from "./intent";
import type { OrderEnvelope, OrderProvenance, OrderSide } from "./intent";
import { isLegalOrderTransition, isTerminalOrderState } from "./order-state";
import type { OrderState } from "./order-state";
import { MAX_SUPPORTED_DECIMAL_SCALE, compareDecimals, fractionalDigits, unitsOf } from "./venue-math";

/**
 * order.ts — the order record a caller holds, and the three things a
 * caller does to it before the venue is involved at all.
 *
 * The split of authority is deliberate and is the whole reason this module
 * is separate from `exchange.ts`:
 *
 * - `PROPOSED -> VALIDATED -> RESERVED` are the CALLER's transitions.
 *   `apps/trading` is what ran the policy check and what took the ledger
 *   reservation, so it is what records that those happened. This adapter
 *   only supplies the guarded step; it never claims an order was validated
 *   or reserved on its own say-so.
 * - Everything from `SUBMITTING` onward belongs to the venue, and only
 *   `createPaperExchange`'s operations produce those transitions. There is
 *   no exported way to move an order to `ACKNOWLEDGED`, `PARTIALLY_FILLED`,
 *   or `FILLED` by hand, because a fill that no execution produced is
 *   exposure the ledger never authorized.
 *
 * A `PaperOrder` is an immutable value. Every operation returns a new one
 * and the caller keeps it; this package stores no caller-side order state,
 * so persistence (issue #34) and the single-writer rule
 * (`docs/resilience.md` §7) stay where they belong.
 */

const ZERO = decimalStringSchema.parse("0");

export type OrderExecution = {
  readonly executionId: string;
  /** The venue's own id for the order this filled. */
  readonly venueOrderId: string;
  /**
   * The intent's idempotency key — the single authorization this fill
   * consumed. Carried on the execution itself, not only on the order,
   * because `VenueReconciliationReport.executions` flattens fills from every
   * order together: an execution read out of that list has no parent record
   * to inherit an identity from, and a fill that cannot be tied back to the
   * approval that authorized it is not an auditable economic record.
   */
  readonly clientOrderId: string;
  /**
   * When the venue reported this execution. In this simulation that is the
   * instant the caller polled or reconciled and the venue handed the
   * execution over — an observation time, not a claim about matching-engine
   * ordering, which a paper venue has no honest way to model.
   */
  readonly reportedAt: IsoUtcTimestamp;
  readonly quantity: DecimalString;
  readonly price: DecimalString;
  readonly notional: DecimalString;
  readonly fee: DecimalString;
  /** The approval that authorized this fill, for the same reason `clientOrderId` is here. */
  readonly provenance: OrderProvenance;
};

export type OrderTransitionRecord = {
  readonly from: OrderState;
  readonly to: OrderState;
  readonly at: IsoUtcTimestamp;
  readonly note: string;
};

export type PaperOrder = {
  /** The idempotency key from the intent; the venue keys its book by this. */
  readonly clientOrderId: string;
  /** Assigned by the venue on acceptance, and `null` until the caller has observed one. */
  readonly venueOrderId: string | null;
  /** Which versioned attempt on the same immutable intent this is. */
  readonly attempt: number;
  readonly venueId: string;
  readonly side: OrderSide;
  readonly quantity: DecimalString;
  readonly inputAssetId: AssetId;
  readonly outputAssetId: AssetId;
  readonly state: OrderState;
  /** Executions the CALLER has observed — not necessarily every execution the venue has. */
  readonly executions: readonly OrderExecution[];
  readonly history: readonly OrderTransitionRecord[];
  readonly provenance: OrderProvenance;
  readonly envelope: OrderEnvelope;
  /**
   * What the venue fixed about this order's economics when it was submitted:
   * the top of book it priced from, the price every execution fills at, the
   * fee rate and the fixture's fixed cost. `null` until submission. Stamped
   * onto the order so the cost breakdown can be recomputed from the order
   * alone — no exchange instance and no quote needed, which is what lets
   * `packages/db` persist an order and `packages/policy` read its economics.
   */
  readonly pricing: VenuePricing | null;
  readonly capabilityVersion: string;
  readonly proposedAt: IsoUtcTimestamp;
  readonly submittedAt: IsoUtcTimestamp | null;
  readonly acknowledgedAt: IsoUtcTimestamp | null;
  readonly closedAt: IsoUtcTimestamp | null;
};

export type ProposeOrderParams = {
  /** Untrusted: parsed against `approvedOrderIntentSchema` before anything reads it. */
  readonly intent: unknown;
  readonly at: IsoUtcTimestamp;
  /**
   * Which attempt on this intent this order is. A retry is a versioned
   * attempt on the same immutable intent, never a fresh authorization
   * (`docs/architecture.md` "Execution lifecycles"), so the caller counts
   * attempts and this adapter records the number it is told.
   */
  readonly attempt?: number;
};

export type ProposeOrderResult =
  | { readonly accepted: true; readonly order: PaperOrder }
  | { readonly accepted: false; readonly refusal: PaperRefusal };

export type OrderTransitionResult =
  | { readonly applied: true; readonly order: PaperOrder }
  | { readonly applied: false; readonly refusal: PaperRefusal };

/**
 * Parses an approved intent and opens a `PROPOSED` order for it. Never
 * throws on schema-legal input and never throws on schema-ILLEGAL input
 * either: a malformed intent is a reason-coded refusal
 * (`docs/resilience.md` §4, §5).
 */
export function proposeOrder(params: ProposeOrderParams): ProposeOrderResult {
  const parsed = approvedOrderIntentSchema.safeParse(params.intent);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".")).filter((path) => path.length > 0)),
    ];
    return {
      accepted: false,
      refusal: adapterRefusal(
        "MALFORMED_INTENT",
        `approved intent failed schema validation${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`,
      ),
    };
  }

  const intent = parsed.data;

  if (intent.adapterCapabilityVersion !== PAPER_ADAPTER_CAPABILITY_VERSION) {
    return {
      accepted: false,
      refusal: adapterRefusal(
        "CAPABILITY_VERSION_MISMATCH",
        `intent was approved against adapter capability "${intent.adapterCapabilityVersion}"; this adapter implements "${PAPER_ADAPTER_CAPABILITY_VERSION}"`,
      ),
    };
  }

  const side = ACTION_ORDER_SIDES[intent.action];
  if (side === null) {
    return {
      accepted: false,
      refusal: adapterRefusal(
        "NON_EXECUTABLE_ACTION",
        `action "${intent.action}" authorizes no execution; it is a decision to do nothing and is never turned into an order`,
      ),
    };
  }

  // Before ANY arithmetic on a caller-supplied amount. `decimalStringSchema`
  // bounds neither precision nor scale (`packages/contracts/src/money.ts`), so
  // a schema-legal amount carrying more fractional digits than this package's
  // arithmetic accepts would throw out of a function this docstring promises
  // never throws. It is refused with a reason code instead
  // (`docs/resilience.md` §4).
  const overPrecise = (
    [
      ["quantity", intent.quantity],
      ["maxSpend", intent.maxSpend],
      ["minAcceptableReceipt", intent.minAcceptableReceipt],
      ["permittedResidual", intent.permittedResidual],
    ] as const
  ).find(([, value]) => fractionalDigits(value) > MAX_SUPPORTED_DECIMAL_SCALE);
  if (overPrecise !== undefined) {
    return {
      accepted: false,
      refusal: adapterRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `${overPrecise[0]} carries ${String(fractionalDigits(overPrecise[1]))} fractional digits; this adapter's arithmetic holds at most ${String(MAX_SUPPORTED_DECIMAL_SCALE)}`,
      ),
    };
  }

  if (compareDecimals(intent.quantity, ZERO) <= 0) {
    return {
      accepted: false,
      refusal: adapterRefusal("NON_POSITIVE_QUANTITY", `order quantity "${intent.quantity}" is not strictly positive`),
    };
  }

  const attempt = params.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    return {
      accepted: false,
      refusal: adapterRefusal("MALFORMED_INTENT", `attempt must be a positive integer, got ${String(attempt)}`),
    };
  }

  return {
    accepted: true,
    order: {
      clientOrderId: intent.idempotencyKey,
      venueOrderId: null,
      attempt,
      venueId: intent.venueId,
      side,
      quantity: intent.quantity,
      inputAssetId: intent.inputAssetId,
      outputAssetId: intent.outputAssetId,
      state: "PROPOSED",
      executions: [],
      history: [],
      provenance: {
        intentId: intent.intentId,
        economicActionId: intent.economicActionId,
        positionPlanId: intent.positionPlanId,
        correlationId: intent.correlationId,
        policyVersion: intent.policyVersion,
        strategyVersion: intent.strategyVersion,
        modelVersion: intent.modelVersion,
        portfolioSnapshotVersion: intent.portfolioSnapshotVersion,
        marketSnapshotVersion: intent.marketSnapshotVersion,
        feeSnapshotVersion: intent.feeSnapshotVersion,
      },
      pricing: null,
      envelope: {
        maxSpend: intent.maxSpend,
        minAcceptableReceipt: intent.minAcceptableReceipt,
        permittedResidual: intent.permittedResidual,
        validUntil: intent.validUntil,
        requiredFreshnessMs: intent.requiredFreshnessMs,
      },
      capabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
      proposedAt: params.at,
      submittedAt: null,
      acknowledgedAt: null,
      closedAt: null,
    },
  };
}

/**
 * The one guarded way an order's state ever moves. Every transition in this
 * package — caller-side and venue-side alike — goes through here, so a
 * transition the diagram does not draw is refused in exactly one place
 * rather than prevented by convention in twelve.
 *
 * Not exported from this package's `index.ts`: `ACKNOWLEDGED -> FILLED` is
 * a legal edge, so a caller holding this function could mark an order
 * filled without a single execution behind it.
 */
export function applyOrderTransition(
  order: PaperOrder,
  to: OrderState,
  at: IsoUtcTimestamp,
  note: string,
): OrderTransitionResult {
  if (!isLegalOrderTransition(order.state, to)) {
    return {
      applied: false,
      refusal: adapterRefusal(
        "ILLEGAL_TRANSITION",
        `${order.state} -> ${to} is not a transition in the Exchange lifecycle (docs/architecture.md "Execution lifecycles")`,
      ),
    };
  }

  return {
    applied: true,
    order: {
      ...order,
      state: to,
      history: [...order.history, { from: order.state, to, at, note }],
      submittedAt: to === "SUBMITTING" ? at : order.submittedAt,
      acknowledgedAt: to === "ACKNOWLEDGED" && order.acknowledgedAt === null ? at : order.acknowledgedAt,
      closedAt: isTerminalOrderState(to) ? at : order.closedAt,
    },
  };
}

/**
 * Records that the caller's policy checks passed: `PROPOSED -> VALIDATED`.
 * This adapter runs no policy check of its own — `packages/policy` owns
 * those — it records the step the caller says it completed.
 */
export function validateOrder(order: PaperOrder, at: IsoUtcTimestamp): OrderTransitionResult {
  return applyOrderTransition(order, "VALIDATED", at, "caller confirmed policy validation");
}

/**
 * Records that the caller took its ledger reservation: `VALIDATED ->
 * RESERVED`. Capital authority lives in `packages/ledger` and
 * `apps/trading`; this is the order's note that it happened, and the state
 * a submission is only accepted from.
 */
export function reserveOrder(order: PaperOrder, at: IsoUtcTimestamp): OrderTransitionResult {
  return applyOrderTransition(order, "RESERVED", at, "caller confirmed capital reservation");
}

/**
 * What the caller owes the ledger once this order's state is known, and what
 * the fill actually cost.
 *
 * Two halves, kept apart because they answer different questions. The release
 * half says what capital comes back; `economics` says what the trade was worth
 * after every cost (`execution-economics.ts`).
 *
 * The arithmetic `docs/resilience.md` §3 demands lives in the release half:
 * filled exposure and the fees paid for it PERSIST through a cancellation, and
 * only the confirmed unfilled remainder is released. The mechanism that
 * enforces "confirmed" is `releasableRemainder` being `null` — not zero, not
 * the remainder — for every state whose outcome the venue has not settled. An
 * `UNKNOWN` order, a `CANCEL_PENDING` order, and a live `PARTIALLY_FILLED`
 * order all release nothing, because in each case the quantity that is still
 * working could yet fill.
 */
export type OrderSettlement = {
  readonly state: OrderState;
  /** True once the order reached a terminal state and its outcome is final. */
  readonly settled: boolean;
  readonly filledQuantity: DecimalString;
  readonly unfilledQuantity: DecimalString;
  /** `null` until the venue has confirmed there is nothing left working. */
  readonly releasableRemainder: DecimalString | null;
  /**
   * Whether a PARTIALLY filled order left a confirmed remainder larger than
   * the residual the intent permitted — the case where the caller has to
   * decide what to do with a position it did not finish building, rather than
   * write the leftover off as dust. An order that never filled at all leaves
   * no residual: the whole quantity simply returns unspent.
   */
  readonly residualExceedsPermitted: boolean;
  /** The full cost breakdown, including which components the price already contained. */
  readonly economics: ExecutionEconomics;
};

function requireUnits(value: DecimalString, scale: number): bigint {
  const units = unitsOf(value, scale);
  if (units === null) {
    throw new Error(`settlementOf: "${value}" does not fit the scale (${String(scale)}) the venue itself rendered it at`);
  }
  return units;
}

export function settlementOf(order: PaperOrder): OrderSettlement {
  const pricing = order.pricing;
  // The scales come from the venue's own stamp rather than from measuring the
  // strings: the executions were rendered at exactly these scales, so summing
  // at them is exact, and an order with no pricing has no executions to sum.
  const quantityScale = pricing === null ? fractionalDigits(order.quantity) : pricing.quantityScale;
  const moneyScale = pricing === null ? 0 : pricing.moneyScale;

  let filledUnits = 0n;
  let grossNotionalUnits = 0n;
  let feeUnits = 0n;
  for (const execution of order.executions) {
    filledUnits += requireUnits(execution.quantity, quantityScale);
    grossNotionalUnits += requireUnits(execution.notional, moneyScale);
    feeUnits += requireUnits(execution.fee, moneyScale);
  }

  const economics = computeExecutionEconomics({
    pricing,
    side: order.side,
    requestedQuantity: order.quantity,
    filledUnits,
    grossNotionalUnits,
    feeUnits,
  });

  const settled = isTerminalOrderState(order.state);
  const releasableRemainder = settled ? economics.unfilledQuantity : null;

  return {
    state: order.state,
    settled,
    filledQuantity: economics.filledQuantity,
    unfilledQuantity: economics.unfilledQuantity,
    releasableRemainder,
    residualExceedsPermitted:
      releasableRemainder !== null &&
      filledUnits > 0n &&
      compareDecimals(releasableRemainder, order.envelope.permittedResidual) > 0,
    economics,
  };
}
