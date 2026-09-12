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

export { reservations, reservationStateEnum } from "./schema/intents";
export type { ReservationStateValue } from "./schema/intents";

export {
  accountKeyFor,
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
  StoredBalance,
} from "./store/journal-store";

export { loadActiveReservations, reserveAvailable } from "./store/reservation-store";
export type { ReserveRequest, ReserveResult } from "./store/reservation-store";

export {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from "./store/pg-errors";
