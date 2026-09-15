import { assetIdSchema } from "@vigil/contracts";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  executionAttempts,
  reservations,
  LIVE_EXECUTION_ATTEMPT_STATES,
  type ReservationStateValue,
} from "../schema/intents";
import { assetScales, journalEntries, journalLines, ledgerBalances } from "../schema/journal";
import {
  accountKeyFor,
  compareAccountKeys,
  describeDriverRefusal,
  type StoreAccount,
  type StoreDiagnosticCode,
  type StoreProvenance,
} from "./journal-store";
import { parseIsoInstant } from "./instants";

/**
 * Taking a reservation durably.
 *
 * This is where the "two strategies try to spend the same funds" scenario is
 * actually decided (`docs/testing.md`, Capital and reservations). The pure
 * arithmetic in `@vigil/ledger` can only answer for the balances it was
 * handed; two processes each holding a stale copy of the same balance would
 * both find their own request feasible. So the store re-does the check with
 * the row locked:
 *
 * 1. Ensure both balance rows exist, inserted in account-key order so two
 *    racing transactions cannot deadlock against each other.
 * 2. `SELECT … FOR UPDATE` both rows, ordered by account key. The second
 *    transaction blocks here until the first commits, and — under READ
 *    COMMITTED, which is Postgres's default and what this repository runs —
 *    re-reads the row it was waiting on, so it sees the balance the first
 *    transaction left behind, not the one it started with.
 * 3. Refuse if the available balance no longer covers the request.
 * 4. Post the hold and update both balances.
 *
 * Step 3 is not the last line of defence. `ledger_balances`'s
 * `holdings_never_negative` check constraint would reject the update even if
 * this function's arithmetic were wrong, which is the difference between an
 * invariant and a convention.
 *
 * A refusal rolls the whole transaction back: a refused reservation leaves
 * no journal entry, no reservation row, and no balance row behind.
 */

export type ReserveRequest = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** Id for the `reservation-hold` entry this reservation posts. */
  readonly entryId: string;
  readonly assetId: string;
  readonly scale: number;
  readonly amountBase: bigint;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  /** ISO-8601 UTC; must be after `occurredAt`. */
  readonly expiresAt: string;
  /** What authorized and sized this hold; stored on the reservation and its posting. */
  readonly provenance: StoreProvenance;
};

export type ReserveResult =
  | {
      readonly outcome: "reserved";
      readonly reservationId: string;
      readonly entryId: string;
      readonly availableBeforeBase: bigint;
      readonly availableAfterBase: bigint;
    }
  /** This idempotency key already holds funds; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly reservationId: string; readonly entryId: string }
  | {
      readonly outcome: "refused";
      readonly code: StoreDiagnosticCode;
      readonly detail: string;
      /**
       * The available balance this store read under the row lock, or `null`
       * when the refusal happened before any balance was read — a malformed
       * request, or a constraint the database rejected. Never a fabricated
       * zero: "we did not look" and "the account is empty" are different
       * answers, and an allocator that confused them would size its next
       * attempt against a balance nobody measured.
       */
      readonly availableBase: bigint | null;
    };

class ReservationRefused extends Error {
  public readonly code: StoreDiagnosticCode;
  public readonly detail: string;
  public readonly availableBase: bigint | null;

  public constructor(code: StoreDiagnosticCode, detail: string, availableBase: bigint | null) {
    super(detail);
    this.name = "ReservationRefused";
    this.code = code;
    this.detail = detail;
    this.availableBase = availableBase;
  }
}

function holdingsAccountFor(assetId: string, holdingsState: "available" | "reserved"): StoreAccount {
  return { family: "holdings", assetId, holdingsState };
}

async function findByIdempotencyKey(
  db: VigilDatabase,
  idempotencyKey: string,
): Promise<{ readonly reservationId: string; readonly journalEntryId: string } | null> {
  const rows = await db
    .select({ reservationId: reservations.reservationId, journalEntryId: reservations.journalEntryId })
    .from(reservations)
    .where(eq(reservations.idempotencyKey, idempotencyKey))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { reservationId: row.reservationId, journalEntryId: row.journalEntryId };
}

/**
 * Reserve base units from an asset's `available` balance.
 *
 * `available` is the only state this function reads, and the guarantee is
 * structural rather than checked: `ReserveRequest` carries no source state,
 * so there is no argument that could point this at a staked, unbonding,
 * exit-queued, or in-flight balance. `@vigil/ledger` refuses a *caller* that
 * asks to reserve from one of those states; nothing wires that registry to
 * this function, and nothing needs to.
 */
export async function reserveAvailable(db: VigilDatabase, request: ReserveRequest): Promise<ReserveResult> {
  const occurredAt = parseIsoInstant(request.occurredAt);
  const recordedAt = parseIsoInstant(request.recordedAt);
  const expiresAt = parseIsoInstant(request.expiresAt);

  if (occurredAt === null || recordedAt === null || expiresAt === null) {
    return {
      outcome: "refused",
      code: "MALFORMED_ENTRY",
      detail: `reservation ${request.reservationId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
      availableBase: null,
    };
  }

  if (!assetIdSchema.safeParse(request.assetId).success) {
    return {
      outcome: "refused",
      code: "MALFORMED_ENTRY",
      detail: `reservation ${request.reservationId} names ${request.assetId}, which is not a canonical asset id`,
      availableBase: null,
    };
  }

  if (request.provenance.policyVersion.trim() === "" || request.provenance.strategyVersion.trim() === "") {
    return {
      outcome: "refused",
      code: "MISSING_PROVENANCE",
      detail: `reservation ${request.reservationId} does not name the policy and strategy versions that authorized it`,
      availableBase: null,
    };
  }

  const availableAccount = holdingsAccountFor(request.assetId, "available");
  const reservedAccount = holdingsAccountFor(request.assetId, "reserved");
  const availableKey = accountKeyFor(availableAccount);
  const reservedKey = accountKeyFor(reservedAccount);
  const accountRows = [
    { account: availableAccount, key: availableKey },
    { account: reservedAccount, key: reservedKey },
  ].sort((left, right) => compareAccountKeys(left.key, right.key));

  const existing = await findByIdempotencyKey(db, request.idempotencyKey);
  if (existing !== null) {
    return { outcome: "duplicate", reservationId: existing.reservationId, entryId: existing.journalEntryId };
  }

  try {
    return await db.transaction(async (tx): Promise<ReserveResult> => {
      // The balance rows below carry (asset_id, asset_scale) foreign keys,
      // so the asset's scale has to be registered first. A scale that
      // disagrees with the registry has nowhere to point and comes back as
      // SCALE_MISMATCH rather than a foreign-key crash.
      await tx
        .insert(assetScales)
        .values({ assetId: request.assetId, assetScale: request.scale })
        .onConflictDoNothing({ target: assetScales.assetId });

      // One statement, rows already in key order: a concurrent transaction
      // either waits here or finds both rows present.
      await tx
        .insert(ledgerBalances)
        .values(
          accountRows.map(({ account, key }) => ({
            accountKey: key,
            accountFamily: account.family,
            holdingsState: account.holdingsState,
            assetId: account.assetId,
            assetScale: request.scale,
            debitBase: 0n,
            creditBase: 0n,
            lastRecordedAt: recordedAt,
          })),
        )
        .onConflictDoNothing({ target: ledgerBalances.accountKey });

      const locked = await tx
        .select({
          accountKey: ledgerBalances.accountKey,
          debitBase: ledgerBalances.debitBase,
          creditBase: ledgerBalances.creditBase,
        })
        .from(ledgerBalances)
        .where(inArray(ledgerBalances.accountKey, [availableKey, reservedKey]))
        .orderBy(asc(ledgerBalances.accountKey))
        .for("update");

      const availableRow = locked.find((row) => row.accountKey === availableKey);
      const availableBase = availableRow === undefined ? 0n : availableRow.debitBase - availableRow.creditBase;

      if (request.amountBase <= 0n) {
        throw new ReservationRefused(
          "MALFORMED_ENTRY",
          `a reservation for ${request.amountBase.toString()} base units authorizes nothing`,
          availableBase,
        );
      }

      if (availableBase < request.amountBase) {
        throw new ReservationRefused(
          "INSUFFICIENT_AVAILABLE",
          `requested ${request.amountBase.toString()} base units of ${request.assetId}; ${availableBase.toString()} is available`,
          availableBase,
        );
      }

      await tx.insert(journalEntries).values({
        entryId: request.entryId,
        kind: "reservation-hold",
        occurredAt,
        recordedAt,
        correlationId: request.correlationId,
        // The journal keeps its own idempotency namespace; deriving the
        // entry's key from the reservation's keeps the two traceable to each
        // other without letting one table's uniqueness silently stand in for
        // the other's.
        idempotencyKey: `hold:${request.idempotencyKey}`,
        intentId: request.intentId,
        reversesEntryId: null,
        policyVersion: request.provenance.policyVersion,
        strategyVersion: request.provenance.strategyVersion,
        modelVersion: request.provenance.modelVersion,
        portfolioSnapshotVersion: request.provenance.portfolioSnapshotVersion,
        marketSnapshotVersion: request.provenance.marketSnapshotVersion,
      });

      await tx.insert(journalLines).values([
        {
          entryId: request.entryId,
          lineIndex: 0,
          accountKey: reservedKey,
          accountFamily: reservedAccount.family,
          holdingsState: reservedAccount.holdingsState,
          assetId: request.assetId,
          assetScale: request.scale,
          direction: "debit",
          amountBase: request.amountBase,
        },
        {
          entryId: request.entryId,
          lineIndex: 1,
          accountKey: availableKey,
          accountFamily: availableAccount.family,
          holdingsState: availableAccount.holdingsState,
          assetId: request.assetId,
          assetScale: request.scale,
          direction: "credit",
          amountBase: request.amountBase,
        },
      ]);

      await tx
        .update(ledgerBalances)
        .set({
          creditBase: sql`${ledgerBalances.creditBase} + ${request.amountBase.toString()}::numeric`,
          lastRecordedAt: recordedAt,
        })
        .where(eq(ledgerBalances.accountKey, availableKey));

      await tx
        .update(ledgerBalances)
        .set({
          debitBase: sql`${ledgerBalances.debitBase} + ${request.amountBase.toString()}::numeric`,
          lastRecordedAt: recordedAt,
        })
        .where(eq(ledgerBalances.accountKey, reservedKey));

      await tx.insert(reservations).values({
        reservationId: request.reservationId,
        intentId: request.intentId,
        attempt: request.attempt,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
        assetId: request.assetId,
        assetScale: request.scale,
        amountBase: request.amountBase,
        state: "active",
        journalEntryId: request.entryId,
        occurredAt,
        recordedAt,
        expiresAt,
        policyVersion: request.provenance.policyVersion,
        strategyVersion: request.provenance.strategyVersion,
        modelVersion: request.provenance.modelVersion,
        portfolioSnapshotVersion: request.provenance.portfolioSnapshotVersion,
        marketSnapshotVersion: request.provenance.marketSnapshotVersion,
      });

      return {
        outcome: "reserved",
        reservationId: request.reservationId,
        entryId: request.entryId,
        availableBeforeBase: availableBase,
        availableAfterBase: availableBase - request.amountBase,
      };
    });
  } catch (error) {
    if (error instanceof ReservationRefused) {
      return { outcome: "refused", code: error.code, detail: error.detail, availableBase: error.availableBase };
    }

    const refusal = describeDriverRefusal(error);
    if (refusal === null) {
      throw error;
    }

    // A duplicate here is the same request arriving twice concurrently: the
    // fast-path lookup above found nothing because the winner had not
    // committed yet. Report the hold that exists rather than a refusal.
    if (refusal.code === "DUPLICATE_RECORD") {
      const duplicate = await findByIdempotencyKey(db, request.idempotencyKey);
      if (duplicate !== null) {
        return { outcome: "duplicate", reservationId: duplicate.reservationId, entryId: duplicate.journalEntryId };
      }
    }

    // The transaction rolled back before any balance was read under a lock,
    // so there is no measured figure to report.
    return { outcome: "refused", code: refusal.code, detail: refusal.detail, availableBase: null };
  }
}

/** Active reservations against one asset, in recorded order, oldest first. */
export async function loadActiveReservations(
  db: VigilDatabase,
  assetId: string,
): Promise<ReadonlyArray<{ readonly reservationId: string; readonly amountBase: bigint; readonly intentId: string }>> {
  const rows = await db
    .select({
      reservationId: reservations.reservationId,
      amountBase: reservations.amountBase,
      intentId: reservations.intentId,
    })
    .from(reservations)
    .where(and(eq(reservations.assetId, assetId), eq(reservations.state, "active")))
    .orderBy(asc(reservations.recordedAt), asc(reservations.reservationId));

  return rows;
}

/**
 * Leaving `active`: the three ways a hold ends, and what each one claims.
 *
 * `reserveAvailable` above is only half a lifecycle. Until the transitions
 * below existed, `reservation_state` had four values of which exactly one
 * was reachable, the partial `reservations_intent_id_active_key` index
 * blocked every intent's next attempt forever, and a hold on a cancelled
 * intent that never filled sat `active` with nothing anywhere able to give
 * the capital back.
 *
 * The three terminal states partition the ways that ends, and each one is
 * admitted only on evidence the database already holds — never on the
 * caller's say-so:
 *
 * - **`consumed`** — an attempt on this intent confirmed a spend. The hold's
 *   funds left through the trade and fee postings and whatever remained came
 *   back through `settle.ts`'s own `reservation-release`; this transition
 *   posts nothing, because those entries already unwound the hold. It is
 *   admitted only when `execution_attempts` records `spent_base > 0` for the
 *   intent, which the consume-once partial unique index makes a fact about
 *   at most one attempt.
 * - **`released`** — the hold ended with nothing consumed and before its
 *   window closed: a cancellation that never filled, or an allocator giving
 *   capital back. Posts a `reservation-release` for the whole hold.
 * - **`expired`** — the same movement, taken because `expires_at` passed
 *   while the hold was still `active`. Posts its own `reservation-release`
 *   too: a hold that expired is not a hold that was posted in error, so the
 *   journal records a new movement rather than a `reversal` erasing the
 *   original (`AGENTS.md`: corrections are reversing entries; this is not a
 *   correction). Exactly-once is the same guarantee either way — the entry's
 *   idempotency key is unique, so a redelivered sweep posts nothing new.
 *
 * ## Why release and expiry refuse an intent that spent or is still live
 *
 * A hold is capital authority, and handing it back is authorizing someone
 * else to spend that capital. Two conditions make that unsafe, and both are
 * checked against durable rows inside the transaction that would do it:
 *
 * - **A live attempt** (`LIVE_EXECUTION_ATTEMPT_STATES`, which counts
 *   `UNKNOWN`). Releasing under a live order hands the same base units to a
 *   second intent while the venue can still fill the first.
 *   `docs/resilience.md` §3 is explicit that an unresolved order releases
 *   nothing and resolves only through reconciliation, so a hold behind an
 *   `UNKNOWN` attempt deliberately does *not* expire. That is the one shape
 *   of hold this module leaves standing, and it is the fail-closed answer.
 * - **A confirmed spend** (`spent_base > 0`). That settlement owns the
 *   unwinding of the hold — part to the venue, the remainder back to
 *   `available` — and a full release beside it would hand back base units
 *   the venue has already taken.
 *
 * Those two conditions are the exact complement of `settle.ts`'s release
 * predicate ("terminal **and** spent > 0"), so the settlement path and the
 * expiry sweep can never both act on one hold: an attempt is live (the sweep
 * refuses), or terminal having spent (the sweep refuses and the settlement
 * releases), or terminal having spent nothing (the settlement posts nothing
 * and the sweep may release). There is no state in between, because
 * `recordAttemptOutcome` writes the terminal state and `spent_base` in one
 * transaction.
 *
 * ## The backing check
 *
 * Above that reasoning sits an arithmetic invariant, because reasoning about
 * orderings is exactly what a crash between two transactions breaks. Before
 * releasing the full hold, both paths re-derive from the journal how many
 * base units this intent still has sitting in `reserved` — debits minus
 * credits on `holdings/reserved/<asset>` across every entry carrying this
 * `intent_id` — and refuse if it is not the whole hold. A partially unwound
 * hold therefore cannot be released again at full size, whatever sequence of
 * crashes and replays produced it. The journal is the source of truth for
 * balances, so the check asks the journal rather than trusting the state
 * column it is about to write.
 *
 * ## What makes a release happen exactly once
 *
 * Three things, and it is worth being exact about which does what, because
 * two of them were measured against a forced-overlap probe rather than
 * reasoned about:
 *
 * 1. **The posting and the state change are one transaction.** Neither can
 *    be durable without the other, so there is no crash point that leaves
 *    the journal and the reservation record disagreeing about whether a hold
 *    ended.
 * 2. **The release entry's idempotency key is unique.** This is the durable
 *    guarantee: with the row lock removed and two sweeps forced to overlap,
 *    the balances still come out right and exactly one release entry exists
 *    — the loser is simply rejected by
 *    `journal_entries_idempotency_key_key` instead of answering cleanly.
 * 3. **`lockHolds` takes the intent's rows `for update`.** This is what turns
 *    that rejection into the right answer — the loser waits, re-reads the
 *    state the winner committed, and reports `noop`. It is also what makes
 *    `consumeReservation`, which touches no balance row and so shares no
 *    other lock with a sweep, contend with one at all.
 *
 * `UPDATE … WHERE state = 'active'` sits under all three: Postgres
 * re-evaluates it against the row a concurrent writer committed, so a second
 * terminal write matches nothing and the transaction that attempted it rolls
 * back whole.
 *
 * ## The seam `#47` builds on
 *
 * `finishHold` below is the single implementation of "release a reservation
 * and move its row" — the posting and the state change in one transaction,
 * so neither can be durable without the other. `#47`'s atomic
 * release-and-open for a partial-fill remainder composes it (release the old
 * hold, open the new one, one transaction) rather than writing a second
 * release path; the pieces it needs — `lockHolds`, `reservedBackingFor`,
 * `finishHold` — are separated here for exactly that.
 */

export const RESERVATION_TRANSITION_CODES = [
  /** No reservation names this intent; there is no hold to move. */
  "RESERVATION_NOT_FOUND",
  /** Every hold on this intent is already terminal, in some other state. */
  "RESERVATION_NOT_ACTIVE",
  /** The hold's `expires_at` has not passed at the instant the sweep is asking about. */
  "RESERVATION_NOT_EXPIRED",
  /** An attempt on this intent is still live, so the hold may not be handed back. */
  "INTENT_ATTEMPT_LIVE",
  /** An attempt on this intent confirmed a spend; its settlement owns the unwinding. */
  "INTENT_ALREADY_SPENT",
  /** Nothing was spent against this intent, so no hold on it was consumed. */
  "INTENT_NOTHING_SPENT",
  /** The journal says this intent's hold is not fully backed in `reserved` any more. */
  "HOLD_ALREADY_UNWOUND",
  /** The instant supplied is not an ISO-8601 UTC instant on a real calendar day. */
  "INVALID_INSTANT",
] as const;

export type ReservationTransitionCode = (typeof RESERVATION_TRANSITION_CODES)[number];

/** Everything a transition can answer with: its own vocabulary plus the store's shared one. */
export type ReservationDiagnosticCode = ReservationTransitionCode | StoreDiagnosticCode;

/** A hold ends in one of these; `active` is not an outcome. */
export type TerminalReservationState = Exclude<ReservationStateValue, "active">;

export type ReleaseHoldRequest = {
  /** The intent whose one live hold is being ended. */
  readonly intentId: string;
  /** Id for the `reservation-release` entry this transition posts. Injected, so a replay is byte-identical. */
  readonly entryId: string;
  /** ISO-8601 UTC; when the hold ended. */
  readonly occurredAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
};

export type ExpireHoldRequest = ReleaseHoldRequest & {
  /** ISO-8601 UTC; the instant the sweep is asking about. The hold expires only if `expires_at` is at or before it. */
  readonly asOf: string;
};

export type ConsumeHoldRequest = {
  /** The intent whose hold the settlement spent. */
  readonly intentId: string;
};

export type ReservationTransitionResult =
  | {
      readonly outcome: "transitioned";
      readonly reservationId: string;
      readonly state: TerminalReservationState;
      /** Base units handed back to `available`; `0n` when the transition posts nothing. */
      readonly releasedBase: bigint;
      /** The `reservation-release` entry this posted, or null when it posted none. */
      readonly entryId: string | null;
    }
  /** The hold is already in the state asked for; nothing was written. */
  | { readonly outcome: "noop"; readonly reservationId: string; readonly state: TerminalReservationState }
  | { readonly outcome: "refused"; readonly code: ReservationDiagnosticCode; readonly detail: string };

/**
 * The handle inside `db.transaction`. Derived from `VigilDatabase`'s own
 * signature rather than named by importing drizzle's internal generic, so it
 * cannot drift from whatever the driver actually hands the callback.
 */
type VigilTransaction = Parameters<Parameters<VigilDatabase["transaction"]>[0]>[0];

class TransitionRefused extends Error {
  public readonly code: ReservationDiagnosticCode;
  public readonly detail: string;

  public constructor(code: ReservationDiagnosticCode, detail: string) {
    super(detail);
    this.name = "TransitionRefused";
    this.code = code;
    this.detail = detail;
  }
}

type LockedHold = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly assetId: string;
  readonly assetScale: number;
  readonly amountBase: bigint;
  readonly state: ReservationStateValue;
  readonly expiresAt: Date;
  readonly provenance: StoreProvenance;
};

/**
 * Every hold on one intent, locked for update, highest attempt last.
 *
 * All of them rather than only the `active` one: a lock on a row that is not
 * there locks nothing, so two callers racing to end the same hold would both
 * read `active` if the predicate were part of the lock. Locking the intent's
 * whole (tiny) set means the loser waits, re-reads what the winner
 * committed, and answers `noop` instead of posting a second release.
 */
async function lockHolds(tx: VigilTransaction, intentId: string): Promise<readonly LockedHold[]> {
  const rows = await tx
    .select({
      reservationId: reservations.reservationId,
      intentId: reservations.intentId,
      attempt: reservations.attempt,
      idempotencyKey: reservations.idempotencyKey,
      correlationId: reservations.correlationId,
      assetId: reservations.assetId,
      assetScale: reservations.assetScale,
      amountBase: reservations.amountBase,
      state: reservations.state,
      expiresAt: reservations.expiresAt,
      policyVersion: reservations.policyVersion,
      strategyVersion: reservations.strategyVersion,
      modelVersion: reservations.modelVersion,
      portfolioSnapshotVersion: reservations.portfolioSnapshotVersion,
      marketSnapshotVersion: reservations.marketSnapshotVersion,
    })
    .from(reservations)
    .where(eq(reservations.intentId, intentId))
    .orderBy(asc(reservations.attempt))
    .for("update");

  return rows.map((row) => ({
    reservationId: row.reservationId,
    intentId: row.intentId,
    attempt: row.attempt,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    assetId: row.assetId,
    assetScale: row.assetScale,
    amountBase: row.amountBase,
    state: row.state,
    expiresAt: row.expiresAt,
    provenance: {
      policyVersion: row.policyVersion,
      strategyVersion: row.strategyVersion,
      modelVersion: row.modelVersion,
      portfolioSnapshotVersion: row.portfolioSnapshotVersion,
      marketSnapshotVersion: row.marketSnapshotVersion,
    },
  }));
}

/**
 * The hold this transition acts on, or the refusal that says why there is
 * none — including the redelivery case, where the answer is that the work is
 * already done rather than that it cannot be done.
 */
function selectHold(
  holds: readonly LockedHold[],
  intentId: string,
  target: TerminalReservationState,
): { readonly kind: "act"; readonly hold: LockedHold } | { readonly kind: "noop"; readonly hold: LockedHold } {
  if (holds.length === 0) {
    throw new TransitionRefused("RESERVATION_NOT_FOUND", `no reservation names intent ${intentId}`);
  }

  const live = holds.find((hold) => hold.state === "active");
  if (live !== undefined) {
    return { kind: "act", hold: live };
  }

  const settled = holds.filter((hold) => hold.state === target).at(-1);
  if (settled !== undefined) {
    return { kind: "noop", hold: settled };
  }

  const states = holds.map((hold) => `${hold.reservationId}=${hold.state}`).join(", ");
  throw new TransitionRefused(
    "RESERVATION_NOT_ACTIVE",
    `intent ${intentId} holds no active reservation to move to ${target}; its reservations are ${states}`,
  );
}

/** What this intent's attempts say about whether its hold may be handed back. */
async function describeIntentActivity(
  tx: VigilTransaction,
  intentId: string,
): Promise<{ readonly liveStates: readonly string[]; readonly spentBase: bigint }> {
  const rows = await tx
    .select({ state: executionAttempts.state, spentBase: executionAttempts.spentBase })
    .from(executionAttempts)
    .where(eq(executionAttempts.intentId, intentId));

  const live: string[] = [];
  let spentBase = 0n;
  for (const row of rows) {
    if ((LIVE_EXECUTION_ATTEMPT_STATES as readonly string[]).includes(row.state)) {
      live.push(row.state);
    }
    spentBase += row.spentBase;
  }
  return { liveStates: live, spentBase };
}

/**
 * How many base units of this intent's hold are still sitting in `reserved`,
 * read off the journal rather than inferred from the reservation row.
 *
 * Debits minus credits on `holdings/reserved/<asset>` over every entry
 * carrying this `intent_id`: the hold debited it, and the trade, fee, and
 * release postings credit it back. An intent whose earlier attempt's hold was
 * already released nets that pair to zero, so the figure is always what the
 * *current* hold still backs.
 */
async function reservedBackingFor(tx: VigilTransaction, intentId: string, reservedKey: string): Promise<bigint> {
  const rows = await tx
    .select({
      netBase: sql<string>`coalesce(sum(case when ${journalLines.direction} = 'debit' then ${journalLines.amountBase} else -${journalLines.amountBase} end), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.entryId, journalLines.entryId))
    .where(and(eq(journalEntries.intentId, intentId), eq(journalLines.accountKey, reservedKey)));

  const row = rows[0];
  return row === undefined ? 0n : BigInt(row.netBase);
}

/**
 * Post the release and move the row, in the caller's transaction.
 *
 * The provenance, correlation id, asset and scale are read off the hold
 * rather than accepted as arguments — the same choice `openExecutionAttempt`
 * makes about an intent's scales. A release is authorized by whatever
 * authorized the hold, and an argument that could disagree with it is an
 * argument that could cut the correlation thread `docs/resilience.md` §10
 * requires.
 *
 * The asset's scale is not registered on the way in the way `reserveAvailable`
 * registers it: `reservations_asset_scale_fk` means the pair on this row is
 * already in `asset_scales`, so there is nothing to register and nothing that
 * could disagree.
 */
async function finishHold(
  tx: VigilTransaction,
  hold: LockedHold,
  target: TerminalReservationState,
  posting: { readonly entryId: string; readonly occurredAt: Date; readonly recordedAt: Date } | null,
): Promise<ReservationTransitionResult> {
  if (posting !== null) {
    const availableKey = accountKeyFor(holdingsAccountFor(hold.assetId, "available"));
    const reservedKey = accountKeyFor(holdingsAccountFor(hold.assetId, "reserved"));

    const backingBase = await reservedBackingFor(tx, hold.intentId, reservedKey);
    if (backingBase !== hold.amountBase) {
      throw new TransitionRefused(
        "HOLD_ALREADY_UNWOUND",
        `reservation ${hold.reservationId} holds ${hold.amountBase.toString()} base units of ${hold.assetId}, but the journal leaves intent ${hold.intentId} ${backingBase.toString()} in reserved; a full release would hand back base units this intent no longer holds`,
      );
    }

    await tx.insert(journalEntries).values({
      entryId: posting.entryId,
      kind: "reservation-release",
      occurredAt: posting.occurredAt,
      recordedAt: posting.recordedAt,
      correlationId: hold.correlationId,
      // The journal keeps its own idempotency namespace, derived from the
      // reservation's — the same shape `reserveAvailable`'s `hold:` prefix
      // uses. This unique key, not the state column, is what makes a
      // redelivered sweep post nothing a second time.
      idempotencyKey: `${target}:${hold.idempotencyKey}`,
      intentId: hold.intentId,
      reversesEntryId: null,
      policyVersion: hold.provenance.policyVersion,
      strategyVersion: hold.provenance.strategyVersion,
      modelVersion: hold.provenance.modelVersion,
      portfolioSnapshotVersion: hold.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: hold.provenance.marketSnapshotVersion,
    });

    await tx.insert(journalLines).values([
      {
        entryId: posting.entryId,
        lineIndex: 0,
        accountKey: availableKey,
        accountFamily: "holdings" as const,
        holdingsState: "available" as const,
        assetId: hold.assetId,
        assetScale: hold.assetScale,
        direction: "debit" as const,
        amountBase: hold.amountBase,
      },
      {
        entryId: posting.entryId,
        lineIndex: 1,
        accountKey: reservedKey,
        accountFamily: "holdings" as const,
        holdingsState: "reserved" as const,
        assetId: hold.assetId,
        assetScale: hold.assetScale,
        direction: "credit" as const,
        amountBase: hold.amountBase,
      },
    ]);

    // Available before reserved, which is the order `reserveAvailable`
    // updates the same two rows in. Two writers that take one pair of row
    // locks in opposite orders deadlock instead of queueing, and agreeing on
    // one order costs nothing.
    await tx
      .update(ledgerBalances)
      .set({
        debitBase: sql`${ledgerBalances.debitBase} + ${hold.amountBase.toString()}::numeric`,
        lastRecordedAt: posting.recordedAt,
      })
      .where(eq(ledgerBalances.accountKey, availableKey));

    await tx
      .update(ledgerBalances)
      .set({
        creditBase: sql`${ledgerBalances.creditBase} + ${hold.amountBase.toString()}::numeric`,
        lastRecordedAt: posting.recordedAt,
      })
      .where(eq(ledgerBalances.accountKey, reservedKey));
  }

  // `state = 'active'` is redundant under the row lock taken above and kept
  // anyway: it is the one predicate that makes a second terminal write
  // impossible even if a future caller reaches here without the lock.
  const moved = await tx
    .update(reservations)
    .set({ state: target })
    .where(and(eq(reservations.reservationId, hold.reservationId), eq(reservations.state, "active")))
    .returning({ reservationId: reservations.reservationId });

  if (moved.length === 0) {
    throw new TransitionRefused(
      "RESERVATION_NOT_ACTIVE",
      `reservation ${hold.reservationId} left 'active' before this transaction could move it to ${target}`,
    );
  }

  return {
    outcome: "transitioned",
    reservationId: hold.reservationId,
    state: target,
    releasedBase: posting === null ? 0n : hold.amountBase,
    entryId: posting === null ? null : posting.entryId,
  };
}

function refuseTransition(error: unknown): ReservationTransitionResult {
  if (error instanceof TransitionRefused) {
    return { outcome: "refused", code: error.code, detail: error.detail };
  }
  const refusal = describeDriverRefusal(error);
  if (refusal === null) {
    throw error;
  }
  return { outcome: "refused", code: refusal.code, detail: refusal.detail };
}

/** Refuse a hand-back whose intent is mid-flight or has already spent. */
function guardHandBack(
  activity: { readonly liveStates: readonly string[]; readonly spentBase: bigint },
  hold: LockedHold,
  target: TerminalReservationState,
): void {
  if (activity.liveStates.length > 0) {
    throw new TransitionRefused(
      "INTENT_ATTEMPT_LIVE",
      `intent ${hold.intentId} has an attempt in ${activity.liveStates.join(", ")}; an unresolved order releases nothing, so its hold is not moved to ${target}`,
    );
  }
  if (activity.spentBase > 0n) {
    throw new TransitionRefused(
      "INTENT_ALREADY_SPENT",
      `intent ${hold.intentId} confirms ${activity.spentBase.toString()} base units spent; that settlement owns the unwinding of reservation ${hold.reservationId}, not a ${target} transition`,
    );
  }
}

/**
 * Hand one intent's live hold back to `available` and record it as
 * `released`: the hold ended without being consumed and before its window
 * closed.
 */
export async function releaseReservation(
  db: VigilDatabase,
  request: ReleaseHoldRequest,
): Promise<ReservationTransitionResult> {
  const occurredAt = parseIsoInstant(request.occurredAt);
  const recordedAt = parseIsoInstant(request.recordedAt);
  if (occurredAt === null || recordedAt === null) {
    return {
      outcome: "refused",
      code: "INVALID_INSTANT",
      detail: `releasing intent ${request.intentId}'s hold carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    };
  }

  try {
    return await db.transaction(async (tx): Promise<ReservationTransitionResult> => {
      const chosen = selectHold(await lockHolds(tx, request.intentId), request.intentId, "released");
      if (chosen.kind === "noop") {
        return { outcome: "noop", reservationId: chosen.hold.reservationId, state: "released" };
      }
      guardHandBack(await describeIntentActivity(tx, request.intentId), chosen.hold, "released");
      return await finishHold(tx, chosen.hold, "released", { entryId: request.entryId, occurredAt, recordedAt });
    });
  } catch (error) {
    return refuseTransition(error);
  }
}

/**
 * Hand back a hold whose window has closed, and record it as `expired`.
 *
 * `asOf` is supplied rather than read from the database clock: every other
 * instant in this package is the caller's, a sweep has to be replayable
 * against injected time, and a store that read `now()` would decide a money
 * question from a clock no test and no replay can set.
 */
export async function expireReservation(
  db: VigilDatabase,
  request: ExpireHoldRequest,
): Promise<ReservationTransitionResult> {
  const occurredAt = parseIsoInstant(request.occurredAt);
  const recordedAt = parseIsoInstant(request.recordedAt);
  const asOf = parseIsoInstant(request.asOf);
  if (occurredAt === null || recordedAt === null || asOf === null) {
    return {
      outcome: "refused",
      code: "INVALID_INSTANT",
      detail: `expiring intent ${request.intentId}'s hold carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    };
  }

  try {
    return await db.transaction(async (tx): Promise<ReservationTransitionResult> => {
      const chosen = selectHold(await lockHolds(tx, request.intentId), request.intentId, "expired");
      if (chosen.kind === "noop") {
        return { outcome: "noop", reservationId: chosen.hold.reservationId, state: "expired" };
      }
      const hold = chosen.hold;

      if (hold.expiresAt.getTime() > asOf.getTime()) {
        throw new TransitionRefused(
          "RESERVATION_NOT_EXPIRED",
          `reservation ${hold.reservationId} authorizes capital until ${hold.expiresAt.toISOString()}, which is after ${request.asOf}`,
        );
      }

      guardHandBack(await describeIntentActivity(tx, request.intentId), hold, "expired");
      return await finishHold(tx, hold, "expired", { entryId: request.entryId, occurredAt, recordedAt });
    });
  } catch (error) {
    return refuseTransition(error);
  }
}

/**
 * Record that a settlement spent this intent's hold.
 *
 * This posts nothing. The trade, the fee, and `settle.ts`'s own
 * `reservation-release` have already moved every base unit of the hold out of
 * `reserved`; a further posting here would move capital a second time. What
 * was missing was the row, and this is the row.
 *
 * It is deliberately safe to call after those postings rather than before: a
 * crash in between leaves the hold `active` with `spent_base > 0`, where the
 * expiry sweep will not touch it and a replay of the settlement re-posts
 * nothing (the entries' idempotency keys) and then moves the row. The
 * opposite order would leave a window in which the hold is already terminal
 * and its postings are not durable.
 *
 * It takes no `ledger_balances` lock, unlike release and expiry: it updates
 * no balance, so it holds only one kind of resource and has no lock order to
 * get wrong.
 */
export async function consumeReservation(
  db: VigilDatabase,
  request: ConsumeHoldRequest,
): Promise<ReservationTransitionResult> {
  try {
    return await db.transaction(async (tx): Promise<ReservationTransitionResult> => {
      const chosen = selectHold(await lockHolds(tx, request.intentId), request.intentId, "consumed");
      if (chosen.kind === "noop") {
        return { outcome: "noop", reservationId: chosen.hold.reservationId, state: "consumed" };
      }

      const activity = await describeIntentActivity(tx, request.intentId);
      if (activity.spentBase <= 0n) {
        throw new TransitionRefused(
          "INTENT_NOTHING_SPENT",
          `no attempt on intent ${request.intentId} confirms a spend, so reservation ${chosen.hold.reservationId} was not consumed; an unspent hold is released or expired, never consumed`,
        );
      }

      return await finishHold(tx, chosen.hold, "consumed", null);
    });
  } catch (error) {
    return refuseTransition(error);
  }
}

/** One hold the sweep may be able to end. */
export type ExpiredHold = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly assetId: string;
  readonly amountBase: bigint;
  /** ISO-8601 UTC. */
  readonly expiresAt: string;
};

export type ExpiredHoldScan =
  | { readonly outcome: "scanned"; readonly holds: readonly ExpiredHold[] }
  | { readonly outcome: "refused"; readonly code: ReservationDiagnosticCode; readonly detail: string };

/** Largest page an expiry scan returns, whatever a caller asks for. */
export const EXPIRED_HOLD_SCAN_LIMIT = 200;

/**
 * Holds that are still `active` with `expires_at` at or before `asOf`,
 * oldest expiry first — the candidate list an expiry sweep walks.
 *
 * Candidates, not verdicts: whether each may actually be handed back is
 * decided by `expireReservation` under the row lock, because an attempt can
 * go live between this read and that transaction. Reading the two halves
 * apart is what keeps the entry ids injectable — the caller mints one per
 * hold — without this function writing anything.
 *
 * It reads `(state, expires_at)`, which is exactly
 * `reservations_state_expires_at_idx`.
 */
export async function loadExpiredReservations(
  db: VigilDatabase,
  options: { readonly asOf: string; readonly limit?: number },
): Promise<ExpiredHoldScan> {
  const asOf = parseIsoInstant(options.asOf);
  if (asOf === null) {
    return {
      outcome: "refused",
      code: "INVALID_INSTANT",
      detail: `${options.asOf} is not an ISO-8601 UTC instant on a real calendar day`,
    };
  }

  const asked = options.limit ?? EXPIRED_HOLD_SCAN_LIMIT;
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, EXPIRED_HOLD_SCAN_LIMIT) : EXPIRED_HOLD_SCAN_LIMIT;

  const rows = await db
    .select({
      reservationId: reservations.reservationId,
      intentId: reservations.intentId,
      assetId: reservations.assetId,
      amountBase: reservations.amountBase,
      expiresAt: reservations.expiresAt,
    })
    .from(reservations)
    .where(and(eq(reservations.state, "active"), lte(reservations.expiresAt, asOf)))
    .orderBy(asc(reservations.expiresAt), asc(reservations.reservationId))
    .limit(limit);

  return {
    outcome: "scanned",
    holds: rows.map((row) => ({
      reservationId: row.reservationId,
      intentId: row.intentId,
      assetId: row.assetId,
      amountBase: row.amountBase,
      expiresAt: row.expiresAt.toISOString(),
    })),
  };
}
