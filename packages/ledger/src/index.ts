/**
 * @vigil/ledger — the multi-asset double-entry journal, the holdings states,
 * atomic reservations, and the rebuild that proves the two agree.
 *
 * Pure by construction: no IO, no clock read, no randomness. Every function
 * takes the state it needs and returns new state plus a result or a
 * reason-coded diagnostic, so the same inputs always produce the same
 * answer — which is what makes a replay meaningful and what keeps
 * `packages/db` the only thing that talks to a database.
 */

export {
  accountKey,
  counterAccount,
  holdingsAccount,
  accountFamilySchema,
  assetIdSchema,
  holdingsStateSchema,
  ledgerAccountSchema,
  postingDirectionSchema,
  ACCOUNT_FAMILIES,
  ACCOUNT_FAMILY_NORMAL_SIDE,
  ASSET_ID_PATTERN,
  HOLDINGS_STATES,
  HOLDINGS_STATE_RESERVABILITY,
  POSTING_DIRECTIONS,
} from "./accounts";
export type { AccountFamily, HoldingsState, LedgerAccount, PostingDirection, StateReservability } from "./accounts";

export {
  assetScaleSchema,
  fromBaseUnits,
  toBaseUnits,
  MAX_ASSET_SCALE,
  MAX_BASE_UNIT_MAGNITUDE,
  MIN_ASSET_SCALE,
} from "./base-units";
export type { BaseUnitResult, DecimalResult } from "./base-units";

export {
  balanceOf,
  compareBalanceSheets,
  holdingsBase,
  netBase,
  rebuildBalances,
} from "./balances";
export type { AccountBalance, BalanceDifference, BalanceSheet, RebuildResult } from "./balances";

export {
  ledgerRefusal,
  policyRefusal,
  LEDGER_DIAGNOSTIC_CODES,
  LEDGER_EMITTED_POLICY_REASON_CODES,
} from "./diagnostics";
export type {
  LedgerDiagnosticCode,
  LedgerEmittedPolicyReasonCode,
  LedgerRefusal,
  RefusalReason,
} from "./diagnostics";

export {
  buildEntry,
  entryKindSchema,
  journalEntrySchema,
  journalLineSchema,
  parseJournalEntry,
  postEntry,
  reverseEntry,
  validateEntry,
  ENTRY_KINDS,
  ENTRY_KIND_ALLOWED_FAMILIES,
} from "./journal";
export type {
  EntryKind,
  EntryValidation,
  JournalEntry,
  JournalEntryDraft,
  JournalLine,
  PostResult,
  ReversalMeta,
} from "./journal";

export { measurePerformance } from "./performance";
export type { PerformanceMeasure, PerformanceResult } from "./performance";

export { planRelease, planReservation, RESERVATION_STATES } from "./reservations";
export type {
  ReleaseOutcome,
  ReleaseRequest,
  ReservationOutcome,
  ReservationRequest,
  ReservationState,
} from "./reservations";

export {
  instantMs,
  isStrictlyBefore,
  isoUtcTimestampSchema,
  ISO_UTC_TIMESTAMP_PATTERN,
} from "./timestamps";
export type { IsoUtcTimestamp } from "./timestamps";
