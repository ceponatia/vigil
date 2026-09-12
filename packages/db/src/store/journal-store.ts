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
import { parseIsoInstant } from "./instants";
import {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_NUMERIC_VALUE_OUT_OF_RANGE,
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
  /** Debits and credits do not match for at least one asset in the entry. */
  "UNBALANCED_ENTRY",
  /** The amount has more digits than a base-unit column holds. */
  "AMOUNT_OUT_OF_RANGE",
  /** The intent already holds funds; a retry is a versioned attempt, not a second hold. */
  "INTENT_ALREADY_HELD",
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

/** What one entry adds to one account's running totals. */
type AccountDelta = {
  readonly line: StoreLine;
  readonly debitBase: bigint;
  readonly creditBase: bigint;
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

/**
 * A total order over account keys, used to take row locks in the same order
 * everywhere. Deliberately a codepoint comparison rather than
 * `localeCompare`: collation depends on the process's locale, and two
 * processes that disagree about the order of two keys deadlock against each
 * other instead of queueing. Equal keys compare 0, so a sort cannot reorder
 * them arbitrarily either.
 */
export function compareAccountKeys(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The per-asset balancing rule, checked in `bigint` before anything is
 * written.
 *
 * `@vigil/ledger` owns this invariant, and `packages/db` may not import it
 * (the layer graph runs one way), so an entry that never went through the
 * ledger would otherwise reach the tables unbalanced. The database enforces
 * the same rule at commit time through the constraint triggers in
 * `drizzle/0003_journal_entry_balanced_guard.sql`; this check exists so the
 * ordinary path answers with a diagnostic instead of a deferred trigger
 * firing on COMMIT.
 */
function describeImbalance(lines: readonly StoreLine[]): string | null {
  const netByAsset = new Map<string, bigint>();
  for (const line of lines) {
    const signed = line.direction === "debit" ? line.amountBase : -line.amountBase;
    netByAsset.set(line.account.assetId, (netByAsset.get(line.account.assetId) ?? 0n) + signed);
  }

  for (const [assetId, net] of netByAsset) {
    if (net !== 0n) {
      return `asset ${assetId} is out of balance by ${net.toString()} base units; debits and credits must match per asset`;
    }
  }
  return null;
}

type EntryPreflight =
  | { readonly outcome: "ok"; readonly occurredAt: Date; readonly recordedAt: Date }
  | { readonly outcome: "refused"; readonly code: StoreDiagnosticCode; readonly detail: string };

/**
 * Reject, before any write, what the driver would only fail on obscurely: an
 * entry with nothing to post, a timestamp that is not a real instant, and a
 * posting that does not balance. Amounts, scales, and the account-family
 * pairing are checked by the table's own constraints, and a violation there
 * comes back as a diagnostic too.
 */
function preflight(entry: StoreEntry): EntryPreflight {
  if (entry.lines.length < 2) {
    return {
      outcome: "refused",
      code: "MALFORMED_ENTRY",
      detail: `entry ${entry.entryId} has ${String(entry.lines.length)} lines; a double-entry posting has at least two`,
    };
  }

  const occurredAt = parseIsoInstant(entry.occurredAt);
  const recordedAt = parseIsoInstant(entry.recordedAt);
  if (occurredAt === null || recordedAt === null) {
    return {
      outcome: "refused",
      code: "MALFORMED_ENTRY",
      detail: `entry ${entry.entryId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    };
  }

  const imbalance = describeImbalance(entry.lines);
  if (imbalance !== null) {
    return { outcome: "refused", code: "UNBALANCED_ENTRY", detail: `entry ${entry.entryId}: ${imbalance}` };
  }

  return { outcome: "ok", occurredAt, recordedAt };
}

/**
 * What a driver error means in this application's vocabulary, or null when
 * it is not a constraint the store recognises — an unreachable database or a
 * malformed query is a real failure and is re-thrown, never reported as a
 * routine refusal. Shared by both stores so the two cannot drift into
 * describing the same violation differently.
 */
export function describeDriverRefusal(
  error: unknown,
): { readonly code: StoreDiagnosticCode; readonly detail: string } | null {
  const code = postgresErrorCode(error);
  const constraint = postgresConstraintName(error) ?? "unknown constraint";

  if (code === PG_CHECK_VIOLATION) {
    if (constraint === "ledger_balances_holdings_never_negative") {
      return { code: "INSUFFICIENT_AVAILABLE", detail: "the posting would credit a holdings account below zero" };
    }
    // Both constraint triggers from drizzle/0003 report under their own
    // trigger name, so the mapping names both rather than matching a suffix.
    if (constraint === "journal_lines_balanced" || constraint === "journal_entries_balanced") {
      return {
        code: "UNBALANCED_ENTRY",
        detail: "the entry is not a balanced double-entry posting for every asset it touches",
      };
    }
    return { code: "CONSTRAINT_VIOLATION", detail: `check constraint ${constraint} rejected the write` };
  }
  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint === "reservations_intent_id_active_key") {
      return { code: "INTENT_ALREADY_HELD", detail: "this intent already holds funds; release the live hold before retrying" };
    }
    return { code: "DUPLICATE_RECORD", detail: `unique constraint ${constraint} rejected the write` };
  }
  if (code === PG_NUMERIC_VALUE_OUT_OF_RANGE) {
    return { code: "AMOUNT_OUT_OF_RANGE", detail: "the amount has more digits than a numeric(78, 0) base-unit column holds" };
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
  const checked = preflight(entry);
  if (checked.outcome === "refused") {
    return checked;
  }
  const { occurredAt, recordedAt } = checked;

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

      // One row per account the entry touches, in account-key order: an
      // entry may post to the same account twice, and two transactions that
      // take their row locks in different orders deadlock instead of
      // queueing.
      const deltas = new Map<string, AccountDelta>();
      for (const line of entry.lines) {
        const key = accountKeyFor(line.account);
        const current = deltas.get(key) ?? { line, debitBase: 0n, creditBase: 0n };
        deltas.set(key, {
          line: current.line,
          debitBase: current.debitBase + (line.direction === "debit" ? line.amountBase : 0n),
          creditBase: current.creditBase + (line.direction === "credit" ? line.amountBase : 0n),
        });
      }
      const ordered = [...deltas.entries()].sort(([left], [right]) => compareAccountKeys(left, right));

      // Ensure the rows exist, then add to them — deliberately two
      // statements rather than one `ON CONFLICT DO UPDATE`.
      //
      // Postgres checks a table's CHECK constraints against the tuple an
      // INSERT proposes, *before* it resolves the conflict. An upsert that
      // credits a holdings account therefore proposes (debit 0, credit N),
      // which fails `ledger_balances_holdings_never_negative` no matter how
      // well funded the account is — so every spend, fee, and sell leg would
      // be rejected as an overspend. Seeding (0, 0) and then updating puts
      // the constraint back on the merged row, which is the balance the rule
      // is actually about.
      await tx
        .insert(ledgerBalances)
        .values(
          ordered.map(([key, delta]) => ({
            accountKey: key,
            accountFamily: delta.line.account.family,
            holdingsState: delta.line.account.holdingsState,
            assetId: delta.line.account.assetId,
            assetScale: delta.line.scale,
            debitBase: 0n,
            creditBase: 0n,
            lastRecordedAt: recordedAt,
          })),
        )
        .onConflictDoNothing({ target: ledgerBalances.accountKey });

      for (const [key, delta] of ordered) {
        await tx
          .update(ledgerBalances)
          .set({
            debitBase: sql`${ledgerBalances.debitBase} + ${delta.debitBase.toString()}::numeric`,
            creditBase: sql`${ledgerBalances.creditBase} + ${delta.creditBase.toString()}::numeric`,
            lastRecordedAt: recordedAt,
          })
          .where(eq(ledgerBalances.accountKey, key));
      }

      return { outcome: "posted", entryId: entry.entryId };
    });
  } catch (error) {
    const refusal = describeDriverRefusal(error);
    if (refusal !== null) {
      return { outcome: "refused", code: refusal.code, detail: refusal.detail };
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
