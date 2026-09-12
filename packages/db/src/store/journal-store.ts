import { asc, eq, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  journalEntries,
  journalLines,
  ledgerBalances,
  type AccountFamilyValue,
  type HoldingsStateValue,
  type JournalEntryKindValue,
  type PostingDirectionValue,
} from "../schema/journal";
import {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from "./pg-errors";

/**
 * Writing and reading the journal.
 *
 * This module persists and retrieves; it decides nothing
 * (`packages/db/README.md`). The one thing that looks like a decision — a
 * posting refused because it would drive a holdings account negative — is
 * the database's own check constraint reported as a diagnostic rather than
 * thrown as a driver error.
 *
 * The record shapes below are deliberately the same shape `@vigil/ledger`
 * produces. The two packages may not import each other (the layer graph
 * forbids it), so the agreement is proved by
 * `tests/replay/journal-rebuild.int.test.ts` instead of by a shared type.
 * Seam: once `packages/contracts` owns the journal record contract, both
 * sides take it from there and the duplication goes away.
 */

export const STORE_DIAGNOSTIC_CODES = [
  /** The posting would credit a holdings account below zero. */
  "INSUFFICIENT_AVAILABLE",
  /** The record could not be read as a journal entry. */
  "MALFORMED_ENTRY",
  /** A unique constraint rejected the write; the record already exists. */
  "DUPLICATE_RECORD",
  /** A check constraint rejected the write. */
  "CONSTRAINT_VIOLATION",
] as const;

export type StoreDiagnosticCode = (typeof STORE_DIAGNOSTIC_CODES)[number];

export type StoreAccount = {
  readonly family: AccountFamilyValue;
  readonly assetId: string;
  readonly holdingsState: HoldingsStateValue | null;
};

export type StoreLine = {
  readonly account: StoreAccount;
  readonly scale: number;
  readonly amountBase: bigint;
  readonly direction: PostingDirectionValue;
};

export type StoreEntry = {
  readonly entryId: string;
  readonly kind: JournalEntryKindValue;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly intentId: string | null;
  readonly reversesEntryId: string | null;
  readonly lines: readonly StoreLine[];
};

export type StoredBalance = {
  readonly accountKey: string;
  readonly accountFamily: AccountFamilyValue;
  readonly holdingsState: HoldingsStateValue | null;
  readonly assetId: string;
  readonly assetScale: number;
  readonly debitBase: bigint;
  readonly creditBase: bigint;
};

export type PostEntryResult =
  | { readonly outcome: "posted"; readonly entryId: string }
  /** The idempotency key was already posted; nothing was written. */
  | { readonly outcome: "duplicate"; readonly entryId: string }
  | { readonly outcome: "refused"; readonly code: StoreDiagnosticCode; readonly detail: string };

/**
 * The account key both packages derive the same way. Seam: this formula
 * belongs in `packages/contracts` beside asset identity, so there is one
 * definition rather than two that must be tested against each other.
 */
export function accountKeyFor(account: StoreAccount): string {
  return `${account.family}|${account.holdingsState ?? "-"}|${account.assetId}`;
}

function parseInstant(value: string): Date | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Reject what the driver would only fail on obscurely — an unparseable
 * timestamp, an entry with nothing to post. Amounts, scales, and the
 * account-family pairing are checked by the table's own constraints, and a
 * violation there comes back as a diagnostic too.
 */
function describeMalformed(entry: StoreEntry): string | null {
  if (entry.lines.length < 2) {
    return `entry ${entry.entryId} has ${String(entry.lines.length)} lines; a double-entry posting has at least two`;
  }
  for (const field of ["occurredAt", "recordedAt"] as const) {
    if (parseInstant(entry[field]) === null) {
      return `entry ${entry.entryId} carries an unparseable ${field}: ${entry[field]}`;
    }
  }
  return null;
}

function refuseFromDriver(error: unknown): PostEntryResult | null {
  const code = postgresErrorCode(error);
  const constraint = postgresConstraintName(error) ?? "unknown constraint";

  if (code === PG_CHECK_VIOLATION) {
    if (constraint === "ledger_balances_holdings_never_negative") {
      return {
        outcome: "refused",
        code: "INSUFFICIENT_AVAILABLE",
        detail: "the posting would credit a holdings account below zero",
      };
    }
    return { outcome: "refused", code: "CONSTRAINT_VIOLATION", detail: `check constraint ${constraint} rejected the write` };
  }
  if (code === PG_UNIQUE_VIOLATION) {
    return { outcome: "refused", code: "DUPLICATE_RECORD", detail: `unique constraint ${constraint} rejected the write` };
  }
  return null;
}

/**
 * Post one entry and fold it into the balance projection, in one
 * transaction. Either the entry, its postings, and every balance it moves
 * are all durable, or none of them are — a half-applied entry is a balance
 * sheet that disagrees with its own journal.
 *
 * Delivered twice with the same idempotency key, it posts once.
 */
export async function postJournalEntry(db: VigilDatabase, entry: StoreEntry): Promise<PostEntryResult> {
  const malformed = describeMalformed(entry);
  if (malformed !== null) {
    return { outcome: "refused", code: "MALFORMED_ENTRY", detail: malformed };
  }

  const occurredAt = new Date(entry.occurredAt);
  const recordedAt = new Date(entry.recordedAt);

  try {
    return await db.transaction(async (tx): Promise<PostEntryResult> => {
      const inserted = await tx
        .insert(journalEntries)
        .values({
          entryId: entry.entryId,
          kind: entry.kind,
          occurredAt,
          recordedAt,
          correlationId: entry.correlationId,
          idempotencyKey: entry.idempotencyKey,
          intentId: entry.intentId,
          reversesEntryId: entry.reversesEntryId,
        })
        .onConflictDoNothing({ target: journalEntries.idempotencyKey })
        .returning({ entryId: journalEntries.entryId });

      if (inserted.length === 0) {
        const existing = await tx
          .select({ entryId: journalEntries.entryId })
          .from(journalEntries)
          .where(eq(journalEntries.idempotencyKey, entry.idempotencyKey))
          .limit(1);
        const row = existing[0];
        return { outcome: "duplicate", entryId: row === undefined ? entry.entryId : row.entryId };
      }

      await tx.insert(journalLines).values(
        entry.lines.map((line, index) => ({
          entryId: entry.entryId,
          lineIndex: index,
          accountKey: accountKeyFor(line.account),
          accountFamily: line.account.family,
          holdingsState: line.account.holdingsState,
          assetId: line.account.assetId,
          assetScale: line.scale,
          direction: line.direction,
          amountBase: line.amountBase,
        })),
      );

      // Sorted by account key so two transactions touching the same pair of
      // accounts always take their row locks in the same order; unsorted
      // upserts deadlock instead of queueing.
      const ordered = [...entry.lines].sort((left, right) =>
        accountKeyFor(left.account) < accountKeyFor(right.account) ? -1 : 1,
      );

      for (const line of ordered) {
        await tx
          .insert(ledgerBalances)
          .values({
            accountKey: accountKeyFor(line.account),
            accountFamily: line.account.family,
            holdingsState: line.account.holdingsState,
            assetId: line.account.assetId,
            assetScale: line.scale,
            debitBase: line.direction === "debit" ? line.amountBase : 0n,
            creditBase: line.direction === "credit" ? line.amountBase : 0n,
            lastRecordedAt: recordedAt,
          })
          .onConflictDoUpdate({
            target: ledgerBalances.accountKey,
            set: {
              debitBase: sql`${ledgerBalances.debitBase} + excluded.debit_base`,
              creditBase: sql`${ledgerBalances.creditBase} + excluded.credit_base`,
              lastRecordedAt: sql`excluded.last_recorded_at`,
            },
          });
      }

      return { outcome: "posted", entryId: entry.entryId };
    });
  } catch (error) {
    const refusal = refuseFromDriver(error);
    if (refusal !== null) {
      return refusal;
    }
    throw error;
  }
}

/**
 * Every entry in replay order, with its postings.
 *
 * Ordered by `entry_sequence`, the durable insertion order — not by a
 * timestamp, which two entries can share.
 */
export async function loadJournalEntries(db: VigilDatabase): Promise<readonly StoreEntry[]> {
  const entryRows = await db.select().from(journalEntries).orderBy(asc(journalEntries.entrySequence));
  const lineRows = await db
    .select()
    .from(journalLines)
    .orderBy(asc(journalLines.entryId), asc(journalLines.lineIndex));

  const linesByEntry = new Map<string, StoreLine[]>();
  for (const row of lineRows) {
    const lines = linesByEntry.get(row.entryId) ?? [];
    lines.push({
      account: { family: row.accountFamily, assetId: row.assetId, holdingsState: row.holdingsState },
      scale: row.assetScale,
      amountBase: row.amountBase,
      direction: row.direction,
    });
    linesByEntry.set(row.entryId, lines);
  }

  return entryRows.map((row) => ({
    entryId: row.entryId,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    intentId: row.intentId,
    reversesEntryId: row.reversesEntryId,
    lines: linesByEntry.get(row.entryId) ?? [],
  }));
}

/** The stored balance projection, for comparison against a rebuild. */
export async function loadBalances(db: VigilDatabase): Promise<readonly StoredBalance[]> {
  const rows = await db.select().from(ledgerBalances).orderBy(asc(ledgerBalances.accountKey));
  return rows.map((row) => ({
    accountKey: row.accountKey,
    accountFamily: row.accountFamily,
    holdingsState: row.holdingsState,
    assetId: row.assetId,
    assetScale: row.assetScale,
    debitBase: row.debitBase,
    creditBase: row.creditBase,
  }));
}
