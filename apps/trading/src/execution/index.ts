/**
 * The execution domain: the policy-checked, idempotent paper execution path.
 *
 * One approved intent, consumed exactly once, carried through a simulated
 * fill by a runtime that cannot be tricked into double-spending, into
 * silently resolving an `UNKNOWN`, into reaching a live endpoint, or into
 * paying costs on a trade whose edge has already evaporated.
 *
 * ```text
 *   authorize.ts   evaluateProposal + recordApprovedIntent
 *   dispatch.ts    reserve -> attempt + outbox -> REVALIDATE -> submit
 *   revalidate.ts  the fresh-quote / net-edge gate every dispatch runs
 *   settle.ts      poll, cancel, reconcile; the confirmed economics and the journal
 *   recover.ts     what a restart owes an unresolved dispatch
 *   venue.ts       the injected cost model, with no default for any limit
 *   venue-economics.ts  the exact arithmetic and the policy cost translation
 * ```
 *
 * PAPER only. `@vigil/adapter-paper` is the one adapter this application
 * imports, `refuseNonPaperAdapter` re-checks that at runtime rather than
 * trusting the type, and `no-live-order.test.ts` asserts at the source level
 * that no path here constructs a live order or a signing request.
 */

export { authorizeProposal } from "./authorize";
export type {
  AuthorizeRefused,
  AuthorizeRequest,
  AuthorizeResult,
  AuthorizedIntent,
  CapitalState,
  TradeProposal,
} from "./authorize";

export {
  executionRefusal,
  fromAdapterRefusal,
  fromPolicyRefusal,
  policyBlock,
  recordableReasonCode,
  EXECUTION_DIAGNOSTIC_CODES,
} from "./diagnostics";
export type { ExecutionDiagnosticCode, ExecutionRefusal, ExecutionRefusalReason } from "./diagnostics";

export {
  attemptStateFor,
  clientOrderIdFor,
  dispatchAttempt,
  payloadDigestFor,
  refuseNonPaperAdapter,
  sideFor,
} from "./dispatch";
export type {
  BlockedDispatch,
  DeclaredAdapterCapability,
  DispatchIdentities,
  DispatchRequest,
  DispatchResult,
  DispatchedAttempt,
  ExecutionRuntime,
  Instrument,
  PositionPlanTerms,
  RefusedDispatch,
} from "./dispatch";

export { isLiveAttemptState, loadUnresolvedDispatches } from "./recover";
export type { UnresolvedDispatch } from "./recover";

export { revalidateBeforeDispatch, REVALIDATION_STAGES } from "./revalidate";
export type {
  DispatchBlocked,
  DispatchClearance,
  ExecutableIntent,
  PortfolioState,
  RevalidationRequest,
  RevalidationResult,
  RevalidationStage,
  ThesisTarget,
} from "./revalidate";

export { cancelAttempt, pollAttempt, reconcileAttempt } from "./settle";
export type { AttemptSettlement, ReconcileRequest, SettleRequest, SettleResult, SettlementIdentities } from "./settle";

export { parseVenueExecutionConfig, venueExecutionConfigSchema } from "./venue";
export type { VenueExecutionConfig, VenueExecutionConfigResult } from "./venue";

export {
  decimalAt,
  envelopeFor,
  netEdgeCostsFor,
  priceExecutable,
  scaleFactor,
  scaledProduct,
  unitsAt,
} from "./venue-economics";
export type {
  ExecutionEnvelope,
  PricingFailure,
  PricingResult,
  Rounding,
  VenuePricingView,
} from "./venue-economics";
