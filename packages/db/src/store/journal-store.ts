import { asc, eq, inArray, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  assetScales,
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
  PG_FOREIGN_KEY_VIOLATION,
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
  /** One asset was posted at two scales, or at a scale it is not registered with. */
  "SCALE_MISMATCH",
  /** The record does not say which policy and strategy versions produced it. */
  "MISSING_PROVENANCE",
  /** A reservation posting is not the exact available/reserved move it claims. */
  "RESERVATION_POSTING_SHAPE",
  /** A reversal's postings are not the exact inverse of the entry it reverses. */
  "REVERSAL_NOT_MIRRORED",
  /** The reversal names an entry that is not in durable history. */
  "UNKNOWN_REVERSAL_TARGET",
  /** Postings may not be added to an entry an earlier transaction posted. */
  "ENTRY_ALREADY_POSTED",
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

/**
 * The versions that produced an economic record. Mirrors
 * `@vigil/ledger`'s `EntryProvenance` — the layer graph forbids importing
 * it, and `tests/seams` is where the two shapes are held to each other.
 */
export type StoreProvenance = {
  readonly policyVersion: string;
  readonly strategyVersion: string;
  readonly modelVersion: string | null;
  readonly portfolioSnapshotVersion: string | null;
  readonly marketSnapshotVersion: string | null;
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
  readonly provenance: StoreProvenance;
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
 * The separator between an account key's components — the same character
 * `@vigil/ledger` exports as `ACCOUNT_KEY_SEPARATOR`, and deliberately not
 * `|`: a canonical asset id contains three `|` of its own, so a `|`-joined
 * key could not be split back into its parts, while `/` is forbidden inside
 * every component of an asset identity.
 */
export const ACCOUNT_KEY_SEPARATOR = "/";

/**
 * The account key both packages derive the same way.
 *
 * "The same way" is enforced by `tests/seams/ledger-db-vocabulary.test.ts`
 * and by nothing else: the layer graph forbids either package importing the
 * other, so this formula is duplicated on purpose and the two copies can
 * only be held together by a test that derives a key from each and compares
 * them. When the two disagree, every balance is written under one key and
 * read under another, and the projection silently reads as empty.
 *
 * Seam: this belongs in `packages/contracts` beside asset identity, so
 * there is one definition rather than two that must be tested against each
 * other.
 */
export function accountKeyFor(account: StoreAccount): string {
  const state = account.holdingsState ?? "-";
  return `${account.family}${ACCOUNT_KEY_SEPARATOR}${state}${ACCOUNT_KEY_SEPARATOR}${account.assetId}`;
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

/**
 * Two postings of one asset at two scales are two different units, and the
 * balance check below would call them equal. The `asset_scales` foreign key
 * makes this unrepresentable durably; this says so at the door, where the
 * caller gets a diagnostic naming the asset instead of a foreign-key error.
 */
function describeScaleClash(lines: readonly StoreLine[]): string | null {
  const scaleByAsset = new Map<string, number>();
  for (const line of lines) {
    const known = scaleByAsset.get(line.account.assetId);
    if (known === undefined) {
      scaleByAsset.set(line.account.assetId, line.scale);
    } else if (known !== line.scale) {
      return `asset ${line.account.assetId} is posted at scale ${String(known)} and scale ${String(line.scale)}`;
    }
  }
  return null;
}

/**
 * The exact state move each reservation kind names — the same rule
 * `@vigil/ledger` enforces in its planner, restated here because a caller
 * may reach this store without going through the planner. A hold that
 * debits `available` and credits `reserved` is the inverse move wearing a
 * hold's name: it releases capital another intent committed.
 */
function describeReservationShape(entry: StoreEntry): string | null {
  if (entry.kind !== "reservation-hold" && entry.kind !== "reservation-release") {
    return null;
  }
  const expected =
    entry.kind === "reservation-hold"
      ? { debit: "reserved", credit: "available" }
      : { debit: "available", credit: "reserved" };

  if (entry.lines.length !== 2) {
    return `a ${entry.kind} moves one amount between two holdings states; this entry has ${String(entry.lines.length)} postings`;
  }
  const debit = entry.lines.find((line) => line.direction === "debit");
  const credit = entry.lines.find((line) => line.direction === "credit");
  if (debit === undefined || credit === undefined) {
    return `a ${entry.kind} has exactly one debit and one credit`;
  }
  if (debit.amountBase !== credit.amountBase || debit.account.assetId !== credit.account.assetId) {
    return `a ${entry.kind} moves one amount of one asset between two states of itself`;
  }
  if (debit.account.holdingsState !== expected.debit || credit.account.holdingsState !== expected.credit) {
    return `a ${entry.kind} debits holdings ${expected.debit} and credits holdings ${expected.credit}`;
  }
  return null;
}

/** The postings of an entry as a comparable, order-independent multiset. */
function postingFingerprint(lines: readonly StoreLine[], flipDirection: boolean): readonly string[] {
  return lines
    .map((line) => {
      const direction = flipDirection ? (line.direction === "debit" ? "credit" : "debit") : line.direction;
      return [accountKeyFor(line.account), String(line.scale), line.amountBase.toString(), direction].join("~");
    })
    .toSorted();
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

  const scaleClash = describeScaleClash(entry.lines);
  if (scaleClash !== null) {
    return { outcome: "refused", code: "SCALE_MISMATCH", detail: `entry ${entry.entryId}: ${scaleClash}` };
  }

  const imbalance = describeImbalance(entry.lines);
  if (imbalance !== null) {
    return { outcome: "refused", code: "UNBALANCED_ENTRY", detail: `entry ${entry.entryId}: ${imbalance}` };
  }

  if (entry.provenance.policyVersion.trim() === "" || entry.provenance.strategyVersion.trim() === "") {
    return {
      outcome: "refused",
      code: "MISSING_PROVENANCE",
      detail: `entry ${entry.entryId} does not name the policy and strategy versions that produced it`,
    };
  }

  const shapeClash = describeReservationShape(entry);
  if (shapeClash !== null) {
    return { outcome: "refused", code: "RESERVATION_POSTING_SHAPE", detail: `entry ${entry.entryId}: ${shapeClash}` };
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
    if (constraint === "journal_lines_entry_sealed") {
      return {
        code: "ENTRY_ALREADY_POSTED",
        detail: "postings may not be added to an entry an earlier transaction posted; a correction is a reversing entry",
      };
    }
    if (constraint === "journal_entries_provenance_present" || constraint === "reservations_provenance_present") {
      return { code: "MISSING_PROVENANCE", detail: "the record does not name the policy and strategy versions that produced it" };
    }
    return { code: "CONSTRAINT_VIOLATION", detail: `check constraint ${constraint} rejected the write` };
  }
  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint === "reservations_intent_id_active_key") {
      return { code: "INTENT_ALREADY_HELD", detail: "this intent already holds funds; release the live hold before retrying" };
    }
    return { code: "DUPLICATE_RECORD", detail: `unique constraint ${constraint} rejected the write` };
  }
  if (code === PG_FOREIGN_KEY_VIOLATION) {
    if (constraint === "journal_entries_reverses_entry_id_fk") {
      return {
        code: "UNKNOWN_REVERSAL_TARGET",
        detail: "the entry this reversal names is not in durable history",
      };
    }
    if (constraint.endsWith("_asset_scale_fk")) {
      return {
        code: "SCALE_MISMATCH",
        detail: "the asset is registered at a different scale; one asset has exactly one scale",
      };
    }
    return { code: "CONSTRAINT_VIOLATION", detail: `foreign key ${constraint} rejected the write` };
  }
  if (code === PG_NUMERIC_VALUE_OUT_OF_RANGE) {
    return { code: "AMOUNT_OUT_OF_RANGE", detail: "the amount has more digits than a numeric(78, 0) base-unit column holds" };
  }
  return null;
}

/**
 * A refusal decided inside the transaction. Thrown rather than returned so
 * the transaction rolls back: a refused posting must leave nothing behind,
 * not even the asset-scale row it registered on the way in.
 */
class PostingRefused extends Error {
  public readonly code: StoreDiagnosticCode;
  public readonly detail: string;

  public constructor(code: StoreDiagnosticCode, detail: string) {
    super(detail);
    this.name = "PostingRefused";
    this.code = code;
    this.detail = detail;
  }
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
      // Register each asset's scale on first use, in asset order so two
      // transactions introducing the same asset queue instead of deadlocking.
      // The composite foreign keys below then have nowhere to point when a
      // later entry posts the same asset at a different scale.
      const assets = [
        ...new Map(entry.lines.map((line): [string, number] => [line.account.assetId, line.scale])).entries(),
      ]
        .map(([assetId, scale]) => ({ assetId, scale }))
        .toSorted((left, right) => compareAccountKeys(left.assetId, right.assetId));

      await tx
        .insert(assetScales)
        .values(assets.map((asset) => ({ assetId: asset.assetId, assetScale: asset.scale })))
        .onConflictDoNothing({ target: assetScales.assetId });

      const registered = await tx
        .select({ assetId: assetScales.assetId, assetScale: assetScales.assetScale })
        .from(assetScales)
        .where(inArray(assetScales.assetId, assets.map((asset) => asset.assetId)));

      for (const asset of assets) {
        const row = registered.find((candidate) => candidate.assetId === asset.assetId);
        if (row !== undefined && row.assetScale !== asset.scale) {
          throw new PostingRefused(
            "SCALE_MISMATCH",
            `asset ${asset.assetId} is registered at scale ${String(row.assetScale)}; entry ${entry.entryId} posts it at scale ${String(asset.scale)}`,
          );
        }
      }

      // A reversal consumes the target's one correction slot, so the target
      // is read under this transaction and its postings compared: a caller
      // working from a stale copy cannot spend that slot on postings of its
      // own choosing.
      if (entry.reversesEntryId !== null) {
        const targetLines = await tx
          .select({
            accountKey: journalLines.accountKey,
            accountFamily: journalLines.accountFamily,
            holdingsState: journalLines.holdingsState,
            assetId: journalLines.assetId,
            assetScale: journalLines.assetScale,
            direction: journalLines.direction,
            amountBase: journalLines.amountBase,
          })
          .from(journalLines)
          .where(eq(journalLines.entryId, entry.reversesEntryId));

        if (targetLines.length === 0) {
          throw new PostingRefused(
            "UNKNOWN_REVERSAL_TARGET",
            `entry ${entry.reversesEntryId} is not in durable history, so there is nothing to reverse`,
          );
        }

        const expected = postingFingerprint(
          targetLines.map((line) => ({
            account: { family: line.accountFamily, assetId: line.assetId, holdingsState: line.holdingsState },
            scale: line.assetScale,
            amountBase: line.amountBase,
            direction: line.direction,
          })),
          true,
        );
        const actual = postingFingerprint(entry.lines, false);
        if (expected.length !== actual.length || expected.some((line, index) => actual[index] !== line)) {
          throw new PostingRefused(
            "REVERSAL_NOT_MIRRORED",
            `entry ${entry.entryId} is not the exact inverse of entry ${entry.reversesEntryId}`,
          );
        }
      }

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
          policyVersion: entry.provenance.policyVersion,
          strategyVersion: entry.provenance.strategyVersion,
          modelVersion: entry.provenance.modelVersion,
          portfolioSnapshotVersion: entry.provenance.portfolioSnapshotVersion,
          marketSnapshotVersion: entry.provenance.marketSnapshotVersion,
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
    if (error instanceof PostingRefused) {
      return { outcome: "refused", code: error.code, detail: error.detail };
    }
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
    provenance: {
      policyVersion: row.policyVersion,
      strategyVersion: row.strategyVersion,
      modelVersion: row.modelVersion,
      portfolioSnapshotVersion: row.portfolioSnapshotVersion,
      marketSnapshotVersion: row.marketSnapshotVersion,
    },
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
