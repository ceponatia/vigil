import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import { reservations } from "../schema/intents";
import { journalEntries, journalLines, ledgerBalances } from "../schema/journal";
import {
  accountKeyFor,
  type StoreAccount,
  type StoreDiagnosticCode,
} from "./journal-store";
import {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from "./pg-errors";

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
      readonly availableBase: bigint;
    };

class ReservationRefused extends Error {
  public readonly code: StoreDiagnosticCode;
  public readonly detail: string;
  public readonly availableBase: bigint;

  public constructor(code: StoreDiagnosticCode, detail: string, availableBase: bigint) {
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
 * `available` is the only state this function reads, by construction: the
 * other five holdings states are refused before a request ever reaches the
 * store (`@vigil/ledger`'s `HOLDINGS_STATE_RESERVABILITY`), and no code path
 * here can be pointed at a staked or in-flight balance.
 */
export async function reserveAvailable(db: VigilDatabase, request: ReserveRequest): Promise<ReserveResult> {
  const occurredAt = new Date(request.occurredAt);
  const recordedAt = new Date(request.recordedAt);
  const expiresAt = new Date(request.expiresAt);

  if ([occurredAt, recordedAt, expiresAt].some((value) => Number.isNaN(value.getTime()))) {
    return {
      outcome: "refused",
      code: "MALFORMED_ENTRY",
      detail: `reservation ${request.reservationId} carries an unparseable timestamp`,
      availableBase: 0n,
    };
  }

  const availableAccount = holdingsAccountFor(request.assetId, "available");
  const reservedAccount = holdingsAccountFor(request.assetId, "reserved");
  const availableKey = accountKeyFor(availableAccount);
  const reservedKey = accountKeyFor(reservedAccount);
  const accountRows = [
    { account: availableAccount, key: availableKey },
    { account: reservedAccount, key: reservedKey },
  ].sort((left, right) => (left.key < right.key ? -1 : 1));

  const existing = await findByIdempotencyKey(db, request.idempotencyKey);
  if (existing !== null) {
    return { outcome: "duplicate", reservationId: existing.reservationId, entryId: existing.journalEntryId };
  }

  try {
    return await db.transaction(async (tx): Promise<ReserveResult> => {
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

    const code = postgresErrorCode(error);
    const constraint = postgresConstraintName(error) ?? "unknown constraint";

    if (code === PG_UNIQUE_VIOLATION) {
      const duplicate = await findByIdempotencyKey(db, request.idempotencyKey);
      if (duplicate !== null) {
        return { outcome: "duplicate", reservationId: duplicate.reservationId, entryId: duplicate.journalEntryId };
      }
      return {
        outcome: "refused",
        code: "DUPLICATE_RECORD",
        detail: `unique constraint ${constraint} rejected the reservation`,
        availableBase: 0n,
      };
    }
    if (code === PG_CHECK_VIOLATION) {
      return {
        outcome: "refused",
        code: constraint === "ledger_balances_holdings_never_negative" ? "INSUFFICIENT_AVAILABLE" : "CONSTRAINT_VIOLATION",
        detail: `check constraint ${constraint} rejected the reservation`,
        availableBase: 0n,
      };
    }
    throw error;
  }
}

/** Reservations held against one asset, newest first by recorded time. */
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
