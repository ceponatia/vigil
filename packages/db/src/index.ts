/**
 * @vigil/db — the Drizzle schema for the record families this application
 * persists, the Postgres client factory, and the store operations that write
 * them transactionally.
 *
 * This package persists and retrieves. Eligibility, risk, and sizing belong
 * to `@vigil/policy`; the accounting arithmetic belongs to `@vigil/ledger`.
 * What lives here is durability: transactions, row locks, unique keys, and
 * check constraints — the guarantees an application-level check cannot make
 * on its own.
 */

export { createDbClient, schema } from "./client";
export type { DbClient, DbClientOptions, VigilDatabase, VigilSchema } from "./client";

export {
  accountFamilyEnum,
  assetScales,
  holdingsStateEnum,
  journalEntries,
  journalEntryKindEnum,
  journalLines,
  ledgerBalances,
  postingDirectionEnum,
  BASE_UNIT_PRECISION,
  MAX_ASSET_SCALE,
} from "./schema/journal";
export type {
  AccountFamilyValue,
  HoldingsStateValue,
  JournalEntryKindValue,
  PostingDirectionValue,
} from "./schema/journal";

export {
  approvedIntents,
  costChargeBasisEnum,
  costComponentKindEnum,
  dispatchStateEnum,
  executionAttempts,
  executionAttemptStateEnum,
  intentCostComponents,
  intentDispatchOutbox,
  netEdgeBasisEnum,
  reservations,
  reservationStateEnum,
  LIVE_EXECUTION_ATTEMPT_STATES,
  TERMINAL_EXECUTION_ATTEMPT_STATES,
} from "./schema/intents";
export type {
  ApprovedIntentRow,
  CostChargeBasisValue,
  CostComponentKindValue,
  DispatchStateValue,
  ExecutionAttemptStateValue,
  NetEdgeBasisValue,
  ReservationStateValue,
} from "./schema/intents";

export {
  candidateEvaluations,
  candidateHorizonEnum,
  candidateOutcomeEnum,
  candidates,
  candidateTranches,
} from "./schema/decisions";

export { heartbeats } from "./schema/ops";

export {
  accountKeyFor,
  ACCOUNT_KEY_SEPARATOR,
  loadBalances,
  loadJournalEntries,
  postJournalEntry,
  STORE_DIAGNOSTIC_CODES,
} from "./store/journal-store";
export type {
  PostEntryResult,
  StoreAccount,
  StoreDiagnosticCode,
  StoreEntry,
  StoreLine,
  StoreProvenance,
  StoredBalance,
} from "./store/journal-store";

export { loadActiveReservations, reserveAvailable } from "./store/reservation-store";
export type { ReserveRequest, ReserveResult } from "./store/reservation-store";

export {
  loadApprovedIntent,
  loadApprovedIntentsByCorrelation,
  recordApprovedIntent,
  COST_CHARGE_BASES,
  COST_COMPONENT_KINDS,
  INTENT_STORE_DIAGNOSTIC_CODES,
  NET_EDGE_BASES,
} from "./store/intent-store";
export type {
  IntentCostComponent,
  IntentEconomics,
  IntentInputSide,
  IntentOutputSide,
  IntentProvenance,
  IntentRefusal,
  IntentStoreDiagnosticCode,
  RecordApprovedIntentResult,
  StoreApprovedIntent,
} from "./store/intent-store";

export {
  abandonDispatch,
  loadDispatch,
  loadExecutionAttempts,
  loadOverspentAttempts,
  loadPendingDispatches,
  loadUnresolvedAttempts,
  markDispatched,
  openExecutionAttempt,
  recordAttemptOutcome,
  EXECUTION_ATTEMPT_STATES,
} from "./store/execution-store";
export type {
  AbandonDispatchRequest,
  AttemptOutcome,
  DispatchClaim,
  DispatchResult,
  MarkDispatchedRequest,
  OpenAttemptRequest,
  OpenAttemptResult,
  RecordAttemptOutcomeResult,
  StoredDispatch,
  StoredExecutionAttempt,
  StoredOverspentAttempt,
} from "./store/execution-store";

export {
  loadCandidates,
  recordCandidate,
  recordCandidateEvaluation,
  CANDIDATE_HORIZONS,
  CANDIDATE_OUTCOMES,
  DECISION_STORE_DIAGNOSTIC_CODES,
} from "./store/decision-store";
export type {
  CandidateHorizon,
  CandidateOutcome,
  DecisionStoreDiagnosticCode,
  RecordCandidateResult,
  RecordEvaluationResult,
  StoreCandidate,
  StoreCandidateEvaluation,
  StoredCandidate,
  StoreTranche,
} from "./store/decision-store";

export {
  loadLatestHeartbeats,
  recordHeartbeat,
  HEARTBEAT_STORE_DIAGNOSTIC_CODES,
} from "./store/heartbeat-store";
export type {
  HeartbeatStoreDiagnosticCode,
  RecordHeartbeatResult,
  StoredHeartbeat,
  StoreHeartbeat,
} from "./store/heartbeat-store";

export {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from "./store/pg-errors";
