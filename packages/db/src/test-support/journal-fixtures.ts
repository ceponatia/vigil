import { sql } from "drizzle-orm";

import { createDbClient, type VigilDatabase } from "../client";
import { reservations } from "../schema/intents";
import {
  journalEntries,
  journalLines,
  ledgerBalances,
  type AccountFamilyValue,
  type HoldingsStateValue,
  type JournalEntryKindValue,
} from "../schema/journal";
import type { StoreAccount, StoreEntry, StoreLine } from "../store/journal-store";

/**
 * Record builders and the shared database handle for this package's own
 * integration suites. Never imported by production code and never exported
 * from `src/index.ts`.
 *
 * Asset ids are `test:`-prefixed and cannot be a real chain-plus-contract
 * identity; no address, key, or holding appears here.
 */

export const TEST_ASSET = "test:stable-6";
export const TEST_SCALE = 6;

export function heldIn(holdingsState: HoldingsStateValue): StoreAccount {
  return { family: "holdings", assetId: TEST_ASSET, holdingsState };
}

export function counterFamily(family: Exclude<AccountFamilyValue, "holdings">): StoreAccount {
  return { family, assetId: TEST_ASSET, holdingsState: null };
}

export function debitOf(account: StoreAccount, amountBase: bigint): StoreLine {
  return { account, scale: TEST_SCALE, amountBase, direction: "debit" };
}

export function creditOf(account: StoreAccount, amountBase: bigint): StoreLine {
  return { account, scale: TEST_SCALE, amountBase, direction: "credit" };
}

export function storeEntry(
  entryId: string,
  kind: JournalEntryKindValue,
  lines: readonly StoreLine[],
  recordedAt = "2026-01-02T03:04:06.000Z",
): StoreEntry {
  return {
    entryId,
    kind,
    occurredAt: "2026-01-02T03:04:05.000Z",
    recordedAt,
    correlationId: `corr-${entryId}`,
    idempotencyKey: `idem-${entryId}`,
    intentId: null,
    reversesEntryId: null,
    lines,
  };
}

/** A synthetic owner deposit: basis in, posted to available. */
export function fundingEntry(entryId: string, amountBase: bigint): StoreEntry {
  return storeEntry(entryId, "contribution", [
    debitOf(heldIn("available"), amountBase),
    creditOf(counterFamily("contributed-capital"), amountBase),
  ]);
}

export type LedgerTestDb = {
  readonly db: VigilDatabase;
  /** Close the pool; every suite that opens one registers this in `afterAll`. */
  readonly close: () => Promise<void>;
  /**
   * Empty every ledger table before a case. `TRUNCATE` does not fire the
   * row-level append-only triggers, which is the only reason a suite can
   * reset a journal the application itself may never delete from
   * (`drizzle/0001_journal_append_only_guard.sql`).
   *
   * Ordered children-first so the run works with or without `cascade`, and
   * `restart identity` so `entry_sequence` — the column a replay reads in
   * order — starts from 1 in every case rather than carrying the previous
   * case's numbering.
   */
  readonly reset: () => Promise<void>;
};

/**
 * Open a pool against the integration database named by `DATABASE_URL`.
 * `packages/db`'s own Postgres-backed suites share this rather than each
 * repeating the client, the close, and the truncate list — a drifting copy
 * of that list is how a suite ends up asserting against another suite's
 * leftover rows.
 */
export function openLedgerTestDb(applicationName: string): LedgerTestDb {
  const client = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", applicationName });
  return {
    db: client.db,
    close: client.close,
    reset: async () => {
      await client.db.execute(
        sql`truncate table ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances} restart identity cascade`,
      );
    },
  };
}
