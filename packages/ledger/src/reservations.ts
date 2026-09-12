import type { AssetId, IsoUtcTimestamp } from "@vigil/contracts";

import {
  holdingsAccount,
  HOLDINGS_STATE_RESERVABILITY,
  type HoldingsState,
} from "./accounts";
import { holdingsBase, type BalanceSheet } from "./balances";
import { ledgerRefusal, type LedgerDiagnosticCode, type LedgerRefusal } from "./diagnostics";
import { buildEntry, type EntryProvenance, type JournalEntry } from "./journal";
import { isStrictlyBefore } from "./timestamps";

/**
 * Reservations: the only way capital is committed to an intent.
 *
 * A reservation moves base units from `available` to `reserved` as a
 * balanced journal entry, so a held balance is not a flag on a row that a
 * crash can lose — it is accounting, reconstructible from the journal like
 * everything else.
 *
 * The rule this module enforces is arithmetic: a reservation may consume
 * only what `available` actually holds, so the second of two reservations
 * whose sum exceeds the balance is refused. That refusal is a reason-coded
 * diagnostic on schema-legal input, never a throw
 * (`docs/resilience.md` §4).
 *
 * This is the *pure* half of the guarantee. Two processes racing on the same
 * balance cannot be serialized by arithmetic alone, so `packages/db` re-does
 * the same check inside a transaction that locks the balance row, with a
 * check constraint underneath it. Both halves are needed:
 * `docs/resilience.md` §9 requires the reservation to be durable before
 * anything acts on it.
 */

export const RESERVATION_STATES = [
  /** Holding funds now; the intent it belongs to may still consume it. */
  "active",
  /** Given back to `available` without being consumed. */
  "released",
  /** Consumed by the economic action it authorized. Terminal. */
  "consumed",
  /** Passed `expiresAt` without being consumed. Terminal. */
  "expired",
] as const;

export type ReservationState = (typeof RESERVATION_STATES)[number];

export type ReservationRequest = {
  readonly reservationId: string;
  /** The approved economic intent this reservation serves. */
  readonly intentId: string;
  /** Versioned attempt on that intent; a retry is a new attempt, never a new authorization. */
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** Id for the journal entry the hold posts. */
  readonly entryId: string;
  readonly assetId: AssetId;
  readonly scale: number;
  readonly amountBase: bigint;
  /** Which holdings state the funds are taken from. Only `available` qualifies. */
  readonly fromState: HoldingsState;
  readonly occurredAt: IsoUtcTimestamp;
  readonly recordedAt: IsoUtcTimestamp;
  readonly expiresAt: IsoUtcTimestamp;
  /** What authorized and sized this hold; carried onto the posting it makes. */
  readonly provenance: EntryProvenance;
};

export type ReservationOutcome =
  | {
      readonly outcome: "reserved";
      readonly entry: JournalEntry;
      readonly requestedBase: bigint;
      readonly availableBeforeBase: bigint;
      readonly availableAfterBase: bigint;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: LedgerRefusal;
      readonly requestedBase: bigint;
      readonly availableBase: bigint;
    };

function refuse(
  refusal: LedgerRefusal,
  requestedBase: bigint,
  availableBase: bigint,
): ReservationOutcome {
  return { outcome: "refused", refusal, requestedBase, availableBase };
}

function refuseWith(code: LedgerDiagnosticCode, detail: string, requestedBase: bigint, availableBase: bigint): ReservationOutcome {
  return refuse(ledgerRefusal(code, detail), requestedBase, availableBase);
}

/**
 * Decide whether a reservation is feasible against the balances supplied,
 * and return the journal entry that takes it.
 *
 * The caller applies the entry (or persists it, which applies it durably).
 * Planning against a stale balance sheet is exactly the race the store's
 * row lock closes — this function's answer is only as current as its input.
 */
export function planReservation(balances: BalanceSheet, request: ReservationRequest): ReservationOutcome {
  const heldBase = holdingsBase(balances, request.assetId, request.fromState);

  if (request.amountBase <= 0n) {
    return refuseWith(
      "NON_POSITIVE_AMOUNT",
      `a reservation for ${request.amountBase.toString()} base units authorizes nothing`,
      request.amountBase,
      heldBase,
    );
  }

  if (!Number.isInteger(request.attempt) || request.attempt < 1) {
    return refuseWith(
      "MALFORMED_ENTRY",
      `attempt ${String(request.attempt)} is not a positive attempt number`,
      request.amountBase,
      heldBase,
    );
  }

  if (!isStrictlyBefore(request.occurredAt, request.expiresAt)) {
    return refuseWith(
      "INVALID_RESERVATION_WINDOW",
      `reservation expires at ${request.expiresAt} which is not after the event at ${request.occurredAt}`,
      request.amountBase,
      heldBase,
    );
  }

  const reservability = HOLDINGS_STATE_RESERVABILITY[request.fromState];
  if (!reservability.reservable) {
    return refuse(reservability.refusal, request.amountBase, heldBase);
  }

  if (heldBase < request.amountBase) {
    return refuseWith(
      "INSUFFICIENT_AVAILABLE",
      `requested ${request.amountBase.toString()} base units of ${request.assetId}; ${heldBase.toString()} is available`,
      request.amountBase,
      heldBase,
    );
  }

  const built = buildEntry({
    entryId: request.entryId,
    kind: "reservation-hold",
    occurredAt: request.occurredAt,
    recordedAt: request.recordedAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
    intentId: request.intentId,
    provenance: request.provenance,
    lines: [
      {
        account: holdingsAccount(request.assetId, "reserved"),
        scale: request.scale,
        amountBase: request.amountBase,
        direction: "debit",
      },
      {
        account: holdingsAccount(request.assetId, request.fromState),
        scale: request.scale,
        amountBase: request.amountBase,
        direction: "credit",
      },
    ],
  });

  if (built.outcome === "refused") {
    return refuse(built.refusal, request.amountBase, heldBase);
  }

  return {
    outcome: "reserved",
    entry: built.entry,
    requestedBase: request.amountBase,
    availableBeforeBase: heldBase,
    availableAfterBase: heldBase - request.amountBase,
  };
}

export type ReleaseRequest = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly entryId: string;
  readonly assetId: AssetId;
  readonly scale: number;
  /** May be less than the reservation: a partial fill releases only the confirmed remainder. */
  readonly amountBase: bigint;
  readonly occurredAt: IsoUtcTimestamp;
  readonly recordedAt: IsoUtcTimestamp;
  /** What authorized the release; carried onto the posting it makes. */
  readonly provenance: EntryProvenance;
};

export type ReleaseOutcome =
  | { readonly outcome: "released"; readonly entry: JournalEntry; readonly reservedAfterBase: bigint }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal; readonly reservedBase: bigint };

/**
 * Give reserved base units back to `available`.
 *
 * The amount is explicit rather than "the whole reservation": a partial fill
 * releases only the confirmed unfilled remainder (`docs/resilience.md` §3),
 * and a release that assumed the full amount would hand back capital the
 * venue has already spent.
 */
export function planRelease(balances: BalanceSheet, request: ReleaseRequest): ReleaseOutcome {
  const reservedBase = holdingsBase(balances, request.assetId, "reserved");

  if (request.amountBase <= 0n) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal("NON_POSITIVE_AMOUNT", `a release of ${request.amountBase.toString()} base units frees nothing`),
      reservedBase,
    };
  }

  if (reservedBase < request.amountBase) {
    return {
      outcome: "refused",
      refusal: ledgerRefusal(
        "RELEASE_EXCEEDS_RESERVED",
        `release of ${request.amountBase.toString()} exceeds the ${reservedBase.toString()} base units of ${request.assetId} on hold`,
      ),
      reservedBase,
    };
  }

  const built = buildEntry({
    entryId: request.entryId,
    kind: "reservation-release",
    occurredAt: request.occurredAt,
    recordedAt: request.recordedAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
    intentId: request.intentId,
    provenance: request.provenance,
    lines: [
      {
        account: holdingsAccount(request.assetId, "available"),
        scale: request.scale,
        amountBase: request.amountBase,
        direction: "debit",
      },
      {
        account: holdingsAccount(request.assetId, "reserved"),
        scale: request.scale,
        amountBase: request.amountBase,
        direction: "credit",
      },
    ],
  });

  if (built.outcome === "refused") {
    return { outcome: "refused", refusal: built.refusal, reservedBase };
  }

  return { outcome: "released", entry: built.entry, reservedAfterBase: reservedBase - request.amountBase };
}
