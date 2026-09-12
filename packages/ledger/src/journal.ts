import { isoUtcTimestampSchema, type IsoUtcTimestamp } from "@vigil/contracts";
import { z } from "zod";

import {
  accountKey,
  ledgerAccountSchema,
  postingDirectionSchema,
  ACCOUNT_FAMILIES,
  type AccountFamily,
  type HoldingsState,
  type LedgerAccount,
  type PostingDirection,
} from "./accounts";
import { assetScaleSchema, MAX_BASE_UNIT_MAGNITUDE } from "./base-units";
import { ledgerRefusal, type LedgerDiagnosticCode, type LedgerRefusal } from "./diagnostics";

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

/**
 * The one posting shape a reservation may take, per kind.
 *
 * "Only holdings accounts" is not a strong enough rule. A `reservation-hold`
 * that debits `available` and credits `reserved` is the *inverse* move: it
 * hands back capital that another intent already committed, while looking
 * in every log like a hold being taken. This registry pins the direction of
 * each side so that entry cannot be built at all.
 *
 * A hold moves value out of `available` (credit, the side that reduces a
 * debit-normal account) and into `reserved` (debit). A release is the
 * inverse.
 */
export const RESERVATION_POSTING_SHAPES: Readonly<
  Record<"reservation-hold" | "reservation-release", { readonly debit: HoldingsState; readonly credit: HoldingsState }>
> = {
  "reservation-hold": { debit: "reserved", credit: "available" },
  "reservation-release": { debit: "available", credit: "reserved" },
};

export type JournalLine = {
  readonly account: LedgerAccount;
  /** Decimal places `amountBase` counts in. One scale per asset, journal-wide. */
  readonly scale: number;
  /** Always positive; `direction` carries the sign. */
  readonly amountBase: bigint;
  readonly direction: PostingDirection;
};

/**
 * The versions of everything that produced an economic record
 * (`AGENTS.md`: "Every economic record carries the timestamp family,
 * correlation and idempotency identifiers, and the policy, strategy, model,
 * and snapshot versions that produced it").
 *
 * Without these, an outcome cannot be attributed: a loss traced to a policy
 * change, a strategy revision, or a model upgrade is indistinguishable from
 * one traced to the market, and a champion/challenger comparison has no way
 * to say which behavior produced which result.
 *
 * `policyVersion` and `strategyVersion` are always present — something
 * always authorized and sized the action, even an owner deposit, which is
 * authorized by the policy in force when it was recorded. The rest are
 * nullable because they are genuinely absent for some records rather than
 * merely unknown: `modelVersion` is null when no LLM was involved (every
 * deterministic path today), and the snapshot versions are null for a
 * record that no market or portfolio snapshot informed, such as a
 * contribution.
 */
export type EntryProvenance = {
  readonly policyVersion: string;
  readonly strategyVersion: string;
  /** Null when no LLM was involved. */
  readonly modelVersion: string | null;
  /** Null when no portfolio snapshot informed the record. */
  readonly portfolioSnapshotVersion: string | null;
  /** Null when no market snapshot informed the record. */
  readonly marketSnapshotVersion: string | null;
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
  /** What produced this record. A reversal carries the versions in force when it was posted, not the target's. */
  readonly provenance: EntryProvenance;
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

export const entryProvenanceSchema = z.object({
  policyVersion: z.string(),
  strategyVersion: z.string(),
  modelVersion: identifierSchema.nullable(),
  portfolioSnapshotVersion: identifierSchema.nullable(),
  marketSnapshotVersion: identifierSchema.nullable(),
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
  provenance: entryProvenanceSchema,
  lines: z.array(journalLineSchema).min(2),
});

function refused(code: LedgerDiagnosticCode, detail: string): EntryValidation {
  return { outcome: "refused", refusal: ledgerRefusal(code, detail) };
}

/**
 * Why this reservation posting is not the state move its kind claims, or
 * null when it is exactly that move.
 */
function describeReservationShape(entry: JournalEntry): string | null {
  const shape = RESERVATION_POSTING_SHAPES[entry.kind === "reservation-hold" ? "reservation-hold" : "reservation-release"];

  if (entry.lines.length !== 2) {
    return `a ${entry.kind} moves one amount between two holdings states; this entry has ${String(entry.lines.length)} postings`;
  }
  const [first, second] = entry.lines;
  if (first === undefined || second === undefined) {
    return `a ${entry.kind} moves one amount between two holdings states`;
  }

  const debit = first.direction === "debit" ? first : second;
  const credit = first.direction === "debit" ? second : first;
  if (debit.direction !== "debit" || credit.direction !== "credit") {
    return `a ${entry.kind} has exactly one debit and one credit`;
  }
  if (debit.amountBase !== credit.amountBase || debit.scale !== credit.scale) {
    return `a ${entry.kind} moves one amount at one scale; this entry moves two`;
  }
  if (debit.account.assetId !== credit.account.assetId) {
    return `a ${entry.kind} moves one asset between two states of itself, not between two assets`;
  }
  if (debit.account.holdingsState !== shape.debit || credit.account.holdingsState !== shape.credit) {
    return `a ${entry.kind} debits holdings ${shape.debit} and credits holdings ${shape.credit}; this entry debits ${String(debit.account.holdingsState)} and credits ${String(credit.account.holdingsState)}`;
  }
  return null;
}

/**
 * The multiset of postings an entry makes, as comparable strings. Sorted so
 * two entries that post the same lines in a different order compare equal.
 */
function postingFingerprint(lines: readonly JournalLine[], flipDirection: boolean): readonly string[] {
  return lines
    .map((line) => {
      const direction = flipDirection ? (line.direction === "debit" ? "credit" : "debit") : line.direction;
      return `${accountKey(line.account)}|${String(line.scale)}|${line.amountBase.toString()}|${direction}`;
    })
    .toSorted();
}

/**
 * Why `reversal` is not the exact inverse of `target`, or null when it is.
 *
 * Proving only that the target exists is not enough: a reversal is the one
 * correction mechanism *and* it consumes the target's single reversal slot,
 * so a stale or malicious caller could post arbitrary balance changes under
 * a reversal's name and leave the real correction impossible. Same accounts,
 * same scales, same amounts, opposite sides, same number of lines.
 */
export function describeReversalMismatch(target: JournalEntry, reversal: JournalEntry): string | null {
  if (target.lines.length !== reversal.lines.length) {
    return `reversal ${reversal.entryId} posts ${String(reversal.lines.length)} lines against ${String(target.lines.length)} in entry ${target.entryId}`;
  }

  const expected = postingFingerprint(target.lines, true);
  const actual = postingFingerprint(reversal.lines, false);
  for (const [index, line] of expected.entries()) {
    if (actual[index] !== line) {
      return `reversal ${reversal.entryId} is not the inverse of entry ${target.entryId}: expected ${line}, found ${String(actual[index])}`;
    }
  }
  return null;
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

  if (entry.kind === "reservation-hold" || entry.kind === "reservation-release") {
    const shapeRefusal = describeReservationShape(entry);
    if (shapeRefusal !== null) {
      return refused("RESERVATION_POSTING_SHAPE", shapeRefusal);
    }
  }

  if (entry.provenance.policyVersion.trim() === "" || entry.provenance.strategyVersion.trim() === "") {
    return refused(
      "MISSING_PROVENANCE",
      `entry ${entry.entryId} does not name the policy and strategy versions that produced it`,
    );
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
    provenance: draft.provenance,
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
    provenance: {
      policyVersion: parsed.data.provenance.policyVersion,
      strategyVersion: parsed.data.provenance.strategyVersion,
      modelVersion: parsed.data.provenance.modelVersion,
      portfolioSnapshotVersion: parsed.data.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: parsed.data.provenance.marketSnapshotVersion,
    },
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

  // An entry may not introduce a second scale for an asset the journal
  // already carries. `validateEntry` sees one entry at a time, so without
  // this an append succeeds and the *rebuild* of the same journal refuses —
  // a process that cannot restart from the history it just wrote.
  const scaleByAsset = new Map<string, number>();
  for (const posted of entries) {
    for (const line of posted.lines) {
      scaleByAsset.set(line.account.assetId, line.scale);
    }
  }
  for (const line of entry.lines) {
    const knownScale = scaleByAsset.get(line.account.assetId);
    if (knownScale !== undefined && knownScale !== line.scale) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal(
          "SCALE_MISMATCH",
          `asset ${line.account.assetId} is already posted at scale ${String(knownScale)}; entry ${entry.entryId} posts it at scale ${String(line.scale)}`,
        ),
      };
    }
  }

  if (entry.reversesEntryId !== null) {
    const targetId = entry.reversesEntryId;
    const target = entries.find((posted) => posted.entryId === targetId);
    if (target === undefined) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal("UNKNOWN_REVERSAL_TARGET", `entry ${targetId} is not in this journal`),
      };
    }
    if (entries.some((posted) => posted.reversesEntryId === targetId)) {
      return {
        outcome: "refused",
        refusal: ledgerRefusal("DUPLICATE_REVERSAL", `entry ${targetId} is already reversed; reversing it twice double-counts`),
      };
    }
    const mismatch = describeReversalMismatch(target, entry);
    if (mismatch !== null) {
      return { outcome: "refused", refusal: ledgerRefusal("REVERSAL_NOT_MIRRORED", mismatch) };
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
  /**
   * The versions in force when the correction is made — not the target's.
   * A correction posted under a later policy is a different decision than
   * the one it corrects, and the journal should say so.
   */
  readonly provenance: EntryProvenance;
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
    provenance: meta.provenance,
    lines: original.lines.map((line) => ({
      account: line.account,
      scale: line.scale,
      amountBase: line.amountBase,
      direction: line.direction === "debit" ? "credit" : "debit",
    })),
  });
}
