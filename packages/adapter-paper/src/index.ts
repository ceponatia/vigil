/**
 * @vigil/adapter-paper — a simulated exchange: the Exchange order
 * lifecycle from `docs/architecture.md`, driven entirely by injected
 * configuration and injected time, with no venue behind it.
 *
 * Deterministic by construction: no clock read, no `Math.random`, no IO, no
 * network client. Time arrives as an `IsoUtcTimestamp` parameter on every
 * operation, fills come from a caller-written behavior script or from a
 * hash of (seed, client order id), and prices come from the submitted quote
 * and a configured slippage cap. The same configuration driven through the
 * same calls with the same timestamps produces identical records, which is
 * what makes a fault-injection suite built on this adapter mean something.
 *
 * Money is exact integer arithmetic throughout — decimal strings on the
 * wire, `bigint` counts of units at a declared scale inside — and every
 * rounding is in the direction that cannot flatter vigil's own accounting.
 *
 * The seam it presents to `apps/trading`:
 *
 *   proposeOrder -> validateOrder -> reserveOrder     (the caller's steps)
 *      -> exchange.submitOrder                        (the venue's, from here on)
 *      -> exchange.pollOrder / exchange.cancelOrder
 *      -> exchange.readVenueState -> exchange.reconcileOrder
 *      -> settlementOf
 *
 * `applyOrderTransition` is deliberately NOT exported: a fill is produced
 * by an execution or it does not exist.
 */

export {
  CONFIRMED_VENUE_STATES,
  LIVE_ORDER_STATES,
  ORDER_STATES,
  ORDER_STATE_TRANSITIONS,
  TERMINAL_ORDER_STATES,
  isLegalOrderTransition,
  isLiveOrderState,
  isTerminalOrderState,
  orderStateSchema,
} from "./order-state";
export type { OrderState } from "./order-state";

export {
  ACTION_ORDER_SIDES,
  ORDER_SIDES,
  TRADE_ACTIONS,
  approvedOrderIntentSchema,
  orderSideSchema,
} from "./intent";
export type { ApprovedOrderIntent, OrderEnvelope, OrderProvenance, OrderSide, TradeAction } from "./intent";

export { proposeOrder, reserveOrder, settlementOf, validateOrder } from "./order";
export type {
  OrderExecution,
  OrderSettlement,
  OrderTransitionRecord,
  OrderTransitionResult,
  PaperOrder,
  ProposeOrderParams,
  ProposeOrderResult,
} from "./order";

export {
  PAPER_ADAPTER_DIAGNOSTIC_CODES,
  PAPER_ADAPTER_POLICY_REASON_CODES,
  adapterRefusal,
  policyRefusal,
} from "./diagnostics";
export type {
  PaperAdapterDiagnosticCode,
  PaperAdapterPolicyReasonCode,
  PaperRefusal,
  PaperRefusalReason,
} from "./diagnostics";

export {
  INJECTABLE_FAULTS,
  PAPER_ADAPTER_CAPABILITY,
  PAPER_ADAPTER_CAPABILITY_VERSION,
  PAPER_ADAPTER_ID,
} from "./capability";
export type { AdapterCapability, InjectableFault } from "./capability";

export { ACKNOWLEDGE_AND_FILL, ACKNOWLEDGE_AND_REST, RECONCILIATION_COVERAGES } from "./faults";
export type {
  CancellationBehavior,
  ExecutionBehavior,
  ExecutionStep,
  ReconciliationCoverage,
  RestingBehavior,
  SubmissionBehavior,
  VenueBehavior,
} from "./faults";

export { createPaperExchange } from "./exchange";
export type {
  CancelOrderRequest,
  CancelOrderResult,
  PaperExchange,
  PaperExchangeConfig,
  PollOrderRequest,
  PollOrderResult,
  ReadVenueStateRequest,
  ReconcileOrderRequest,
  ReconcileOrderResult,
  SubmitOrderRequest,
  SubmitOrderResult,
  VenueOrderView,
  VenueReconciliationReport,
} from "./exchange";
