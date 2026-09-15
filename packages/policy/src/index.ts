/**
 * @vigil/policy — the pure, deterministic gate between a proposal and a
 * reservation of real capital: whether it is eligible, what size it may
 * take, and — when it may not proceed — which reason code says why.
 *
 * Pure by construction: no IO, no clock read (`now` is always injected), no
 * randomness, no LLM. Every function takes the state it needs and returns a
 * result or a reason-coded refusal, so the same inputs always produce the
 * same answer — which is what makes an opportunity journal replayable and
 * what keeps `packages/ledger` and `packages/db` the only things that
 * commit anything.
 *
 * Nothing here moves money. An approved evaluation is an answer, not a
 * reservation, an intent, or an order (`docs/architecture.md`
 * "Portfolio/risk allocator").
 *
 * Every limit is injected configuration validated by `parsePolicyConfig`.
 * `docs/policy.md`'s numerical table is explicitly unapproved discussion
 * defaults, so this package hardcodes no owner number and supplies no
 * default for any limit — a malformed or missing limit set refuses rather
 * than falling back to something permissive.
 */

export {
  parsePolicyConfig,
  policyConfigSchema,
  scaleBoundedDecimalSchema,
  MAX_QUANTITY_SCALE,
} from "./config";
export type { PolicyConfig, PolicyConfigResult } from "./config";

export {
  inputRefusal,
  isPolicyReason,
  policyRefusal,
  POLICY_DIAGNOSTIC_CODES,
  POLICY_EMITTED_REASON_CODES,
} from "./diagnostics";
export type {
  PolicyDiagnosticCode,
  PolicyEmittedReasonCode,
  PolicyRefusal,
  RefusalReason,
} from "./diagnostics";

export {
  checkAccountReconciled,
  checkEntryZone,
  checkExposure,
  checkNetEdge,
  checkQuoteFreshness,
  entryZoneSchema,
  exposureCapSchema,
  reconciliationStateSchema,
  EXPOSURE_SCOPES,
} from "./eligibility";
export type {
  CheckAccountReconciledParams,
  CheckEntryZoneParams,
  CheckExposureParams,
  CheckNetEdgeParams,
  CheckQuoteFreshnessParams,
  EligibilityResult,
  EntryZone,
  ExposureCap,
  ExposureResult,
  ExposureScope,
  NetEdgeBreakdown,
  NetEdgeResult,
  QuoteFreshnessResult,
  ReconciliationState,
} from "./eligibility";

export { negativeCostComponent, netEdgeCostsSchema } from "./costs";
export type { NetEdgeCosts } from "./costs";

export { sizeTrade, sizingInputsSchema, SIZE_BOUNDS } from "./sizing";
export type {
  BoundQuantity,
  SizeBound,
  SizeTradeParams,
  SizedTrade,
  SizingBreakdown,
  SizingInputs,
  SizingResult,
} from "./sizing";

export { evaluateProposal, proposalEvaluationParamsSchema, EVALUATION_STAGES } from "./evaluate";
export type {
  ApprovedEvaluation,
  EvaluationStage,
  ProposalEvaluation,
  ProposalEvaluationParams,
  RefusedEvaluation,
} from "./evaluate";

// Decimal arithmetic is deliberately NOT exported. It is this package's
// private, duplicated-on-purpose seam (see `scaled-decimal.ts` and issue
// #20); a consumer reaching for it would be depending on a helper that is
// meant to disappear into a shared one.
