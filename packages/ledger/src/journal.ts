import { z } from "zod";

import {
  ledgerAccountSchema,
  postingDirectionSchema,
  ACCOUNT_FAMILIES,
  type AccountFamily,
  type LedgerAccount,
  type PostingDirection,
} from "./accounts";
import { assetScaleSchema, MAX_BASE_UNIT_MAGNITUDE } from "./base-units";
import { ledgerRefusal, type LedgerDiagnosticCode, type LedgerRefusal } from "./diagnostics";
import { isoUtcTimestampSchema, type IsoUtcTimestamp } from "./timestamps";

/**
 * The append-only double-entry journal.
 *
 * Two rules this module exists to make unbreakable:
 *
 * 1. **Every entry balances, per asset.** Debits equal credits for each
 *    asset in the entry — not netted across assets, because valuing one
 *    asset in another needs market data this package may not have.
 * 2. **Nothing is ever edited.** There is no update function and no delete
 *    function, here or anywhere downstream: a correction is `reverseEntry`
 *    followed by the corrected posting, so the record of what was believed,
 *    and when, survives the correction. `packages/db` enforces the same rule
 *    durably with a trigger, because an invariant only the application holds
 *    is one `UPDATE` away from being gone.
 */

export const ENTRY_KINDS = [
  /** Owner deposit: basis in, never profit. */
  "contribution",
  /** Owner withdrawal: basis out, never a loss. */
  "distribution",
  /** An exchange of one asset for another, each leg clearing through `exchange`. */
  "trade",
  /** A cost paid to a venue, chain, or counterparty. */
  "fee",
  /** Recognition of realized gain or loss against the exchange clearing account. */
  "realized-pnl",
  /** available -> reserved, taken by a reservation. */
  "reservation-hold",
  /** reserved -> available, given back by a release. */
  "reservation-release",
  /** The mirror of an earlier entry; the only way to correct one. */
  "reversal",
] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];

export const entryKindSchema = z.enum(ENTRY_KINDS);

/**
 * Which account families each kind may touch. A deposit that lands in
 * `realized-pnl` would read as profit forever after — inflating performance,
 * moving the cash-flow-adjusted high-water mark, and clearing a drawdown
 * pause that should still be in force. This registry refuses that posting at
 * the door rather than trusting every future caller to know the rule.
 *
 * `reversal` may touch any family: it mirrors whatever it reverses, and the
 * original was already checked against its own kind.
 */
export const ENTRY_KIND_ALLOWED_FAMILIES: Readonly<Record<EntryKind, readonly AccountFamily[]>> = {
  contribution: ["holdings", "contributed-capital"],
  distribution: ["holdings", "contributed-capital"],
  trade: ["holdings", "exchange"],
  fee: ["holdings", "fees"],
  "realized-pnl": ["holdings", "exchange", "realized-pnl"],
  "reservation-hold": ["holdings"],
  "reservation-release": ["holdings"],
  reversal: ACCOUNT_FAMILIES,
};

export type JournalLine = {
  readonly account: LedgerAccount;
  /** Decimal places `amountBase` counts in. One scale per asset, journal-wide. */
  readonly scale: number;
  /** Always positive; `direction` carries the sign. */
  readonly amountBase: bigint;
  readonly direction: PostingDirection;
};

export type JournalEntry = {
  readonly entryId: string;
  readonly kind: EntryKind;
  readonly occurredAt: IsoUtcTimestamp;
  readonly recordedAt: IsoUtcTimestamp;
  /** Traces this entry to the intent, attempt, and outcome it belongs to. */
  readonly correlationId: string;
  /** The same economic event delivered twice posts once. */
  readonly idempotencyKey: string;
  /** The approved economic intent this entry settles, when there is one. */
  readonly intentId: string | null;
  /** Non-null exactly when `kind` is `reversal`. */
  readonly reversesEntryId: string | null;
  readonly lines: readonly JournalLine[];
};

export type JournalEntryDraft = Omit<JournalEntry, "intentId" | "reversesEntryId"> & {
  readonly intentId?: string | null;
  readonly reversesEntryId?: string | null;
};

export type EntryValidation =
  | { readonly outcome: "valid"; readonly entry: JournalEntry }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal };

export type PostResult =
  | { readonly outcome: "posted"; readonly entries: readonly JournalEntry[] }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal };

const identifierSchema = z.string().min(1).max(200);

export const journalLineSchema = z.object({
  account: ledgerAccountSchema,
  scale: assetScaleSchema,
  amountBase: z.bigint(),
  direction: postingDirectionSchema,
});

export const journalEntrySchema = z.object({
  entryId: identifierSchema,
  kind: entryKindSchema,
  occurredAt: isoUtcTimestampSchema,
  recordedAt: isoUtcTimestampSchema,
  correlationId: identifierSchema,
  idempotencyKey: identifierSchema,
  intentId: identifierSchema.nullable(),
  reversesEntryId: identifierSchema.nullable(),
  lines: z.array(journalLineSchema).min(2),
});

function refused(code: LedgerDiagnosticCode, detail: string): EntryValidation {
  return { outcome: "refused", refusal: ledgerRefusal(code, detail) };
}

/**
 * Check every invariant an entry must satisfy before it can be posted or
 * replayed. Called on both paths on purpose: an entry read back from the
 * database is data that crossed a trust boundary, not a value this process
 * created (`docs/resilience.md` §5).
 */
export function validateEntry(entry: JournalEntry): EntryValidation {
  const parsed = journalEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return refused("MALFORMED_ENTRY", parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const allowed = ENTRY_KIND_ALLOWED_FAMILIES[entry.kind];
  const debitsByAsset = new Map<string, bigint>();
  const creditsByAsset = new Map<string, bigint>();
  const scaleByAsset = new Map<string, number>();

  for (const line of entry.lines) {
    if (line.amountBase <= 0n) {
      return refused(
        "NON_POSITIVE_AMOUNT",
        `entry ${entry.entryId} posts ${line.amountBase.toString()} base units; direction carries the sign`,
      );
    }
    if (line.amountBase > MAX_BASE_UNIT_MAGNITUDE) {
      return refused(
        "AMOUNT_OUT_OF_RANGE",
        `entry ${entry.entryId} posts an amount of ${String(line.amountBase.toString().length)} digits; base-unit columns hold 78`,
      );
    }
    if (!allowed.includes(line.account.family)) {
      return refused(
        "ENTRY_KIND_ACCOUNT_MISMATCH",
        `a ${entry.kind} entry may not post to a ${line.account.family} account`,
      );
    }

    const assetId = line.account.assetId;
    const knownScale = scaleByAsset.get(assetId);
    if (knownScale === undefined) {
      scaleByAsset.set(assetId, line.scale);
    } else if (knownScale !== line.scale) {
      return refused(
        "SCALE_MISMATCH",
        `asset ${assetId} appears at scale ${String(knownScale)} and scale ${String(line.scale)} in entry ${entry.entryId}`,
      );
    }

    const side = line.direction === "debit" ? debitsByAsset : creditsByAsset;
    side.set(assetId, (side.get(assetId) ?? 0n) + line.amountBase);
  }

  for (const assetId of scaleByAsset.keys()) {
    const debits = debitsByAsset.get(assetId) ?? 0n;
    const credits = creditsByAsset.get(assetId) ?? 0n;
    if (debits !== credits) {
      return refused(
        "UNBALANCED_ENTRY",
        `asset ${assetId} in entry ${entry.entryId} debits ${debits.toString()} against credits ${credits.toString()}`,
      );
    }
  }

  const isReversal = entry.kind === "reversal";
  if (isReversal && entry.reversesEntryId === null) {
    return refused("MALFORMED_ENTRY", `reversal ${entry.entryId} does not name the entry it reverses`);
  }
  if (!isReversal && entry.reversesEntryId !== null) {
    return refused("MALFORMED_ENTRY", `a ${entry.kind} entry may not claim to reverse another entry`);
  }

  return { outcome: "valid", entry };
}

/** Build a validated entry, filling in the optional references as explicit nulls. */
export function buildEntry(draft: JournalEntryDraft): EntryValidation {
  return validateEntry({
    entryId: draft.entryId,
    kind: draft.kind,
    occurredAt: draft.occurredAt,
    recordedAt: draft.recordedAt,
    correlationId: draft.correlationId,
    idempotencyKey: draft.idempotencyKey,
    intentId: draft.intentId ?? null,
    reversesEntryId: draft.reversesEntryId ?? null,
    lines: draft.lines,
  });
}

/**
 * Parse an entry that came from outside this process — a database row, a
 * replay file — into the typed, validated shape. Returns a refusal rather
 * than throwing, so a single corrupt row surfaces as a diagnostic instead of
 * taking down a rebuild.
 */
export function parseJournalEntry(value: unknown): EntryValidation {
  const parsed = journalEntrySchema.safeParse(value);
  if (!parsed.success) {
    return refused("MALFORMED_ENTRY", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return validateEntry({
    entryId: parsed.data.entryId,
    kind: parsed.data.kind,
    occurredAt: parsed.data.occurredAt,
    recordedAt: parsed.data.recordedAt,
    correlationId: parsed.data.correlationId,
    idempotencyKey: parsed.data.idempotencyKey,
    intentId: parsed.data.intentId,
    reversesEntryId: parsed.data.reversesEntryId,
    lines: parsed.data.lines.map((line) => ({
      account: {
        family: line.account.family,
        assetId: line.account.assetId,
        holdingsState: line.account.holdingsState,
      },
      scale: line.scale,
      amountBase: line.amountBase,
      direction: line.direction,
    })),
  });
}

/**
 * Append a validated entry. The journal is a value: posting returns a new
 * sequence and never mutates the one it was given.
 */
export function postEntry(entries: readonly JournalEntry[], entry: JournalEntry): PostResult {
  const validation = validateEntry(entry);
  if (validation.outcome === "refused") {
    return validation;
  }

  for (const posted of entries) {
    if (posted.entryId === entry.entryId) {
      return { outcome: "refused", refusal: ledgerRefusal("DUPLICATE_ENTRY_ID", `entry ${entry.entryId} is already posted`) };
    }
    if (posted.idempotencyKey === entry.idempotencyKey) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `idempotency key ${entry.idempotencyKey} already posted as entry ${posted.entryId}`,
        ),
      };
    }
  }

  if (entry.reversesEntryId !== null) {
    const target = entry.reversesEntryId;
    if (!entries.some((posted) => posted.entryId === target)) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal("UNKNOWN_REVERSAL_TARGET", `entry ${target} is not in this journal`),
      };
    }
    if (entries.some((posted) => posted.reversesEntryId === target)) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal("DUPLICATE_REVERSAL", `entry ${target} is already reversed; reversing it twice double-counts`),
      };
    }
  }

  return { outcome: "posted", entries: [...entries, entry] };
}

export type ReversalMeta = {
  readonly entryId: string;
  readonly occurredAt: IsoUtcTimestamp;
  readonly recordedAt: IsoUtcTimestamp;
  readonly correlationId: string;
  readonly idempotencyKey: string;
};

/**
 * The mirror of an already-posted entry: same lines, opposite sides. This is
 * the only correction mechanism — the original entry is never touched, so
 * "what did we believe on the day" and "what is true now" both stay
 * answerable.
 */
export function reverseEntry(original: JournalEntry, meta: ReversalMeta): EntryValidation {
  return buildEntry({
    entryId: meta.entryId,
    kind: "reversal",
    occurredAt: meta.occurredAt,
    recordedAt: meta.recordedAt,
    correlationId: meta.correlationId,
    idempotencyKey: meta.idempotencyKey,
    intentId: original.intentId,
    reversesEntryId: original.entryId,
    lines: original.lines.map((line) => ({
      account: line.account,
      scale: line.scale,
      amountBase: line.amountBase,
      direction: line.direction === "debit" ? "credit" : "debit",
    })),
  });
}
