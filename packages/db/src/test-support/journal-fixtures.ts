import { assetIdSchema } from "@vigil/contracts";
import { sql } from "drizzle-orm";

import { createDbClient, type VigilDatabase } from "../client";
import { candidateEvaluations, candidates, candidateTranches } from "../schema/decisions";
import { reservations } from "../schema/intents";
import { heartbeats } from "../schema/ops";
import {
  assetScales,
  journalEntries,
  journalLines,
  ledgerBalances,
  type AccountFamilyValue,
  type HoldingsStateValue,
  type JournalEntryKindValue,
} from "../schema/journal";
import type { StoreAccount, StoreEntry, StoreLine, StoreProvenance } from "../store/journal-store";

/**
 * Record builders and the shared database handle for this package's own
 * integration suites. Never imported by production code and never exported
 * from `src/index.ts`.
 *
 * Asset ids are canonical four-component identities on chain `1337` — the
 * id this codebase reserves for the synthetic test chain — with
 * denominations no real chain issues. No address, key, or holding appears
 * here.
 */

// Parsed through `@vigil/contracts`' schema rather than written out as a
// bare string: a fixture that could not itself pass the identity rule would
// be testing the store against records the application cannot produce.
export const TEST_ASSET: string = assetIdSchema.parse("1337|native|VGLSTABLE|SYNTHETIC_TESTNET");
export const TEST_SCALE = 6;

/** A second synthetic asset, for the claims that need two. */
export const TEST_OTHER_ASSET: string = assetIdSchema.parse("1337|native|VGLOTHER|SYNTHETIC_TESTNET");

/**
 * The provenance a fixture record carries: deterministic, obviously
 * synthetic, and with `modelVersion` null because no LLM produces any
 * posting this package makes.
 */
export const TEST_PROVENANCE: StoreProvenance = {
  policyVersion: "policy-test-0",
  strategyVersion: "strategy-test-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

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
    provenance: TEST_PROVENANCE,
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
   * Empty every table this package writes before a case — the ledger tables
   * and the `decisions` and `ops` tables alike. One list rather than one per
   * suite: a second, parallel truncate somewhere else is how a suite that
   * never heard of candidates ends up asserting against another suite's
   * leftover rows.
   *
   * `TRUNCATE` does not fire the row-level append-only triggers, which is
   * the only reason a suite can reset a journal, or a candidate, that the
   * application itself may never delete from
   * (`drizzle/0001_journal_append_only_guard.sql`,
   * `drizzle/0008_candidate_append_only_guard.sql`).
   *
   * `asset_scales` goes with the ledger tables: it is referenced by three of
   * them, so one `TRUNCATE` has to name them all, and a suite that left it
   * behind would assert against another suite's registered assets.
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
        sql`truncate table ${candidateEvaluations}, ${candidateTranches}, ${candidates}, ${heartbeats}, ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances}, ${assetScales} restart identity cascade`,
      );
    },
  };
}
