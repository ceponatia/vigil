import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import { reservations } from "../schema/intents";
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
