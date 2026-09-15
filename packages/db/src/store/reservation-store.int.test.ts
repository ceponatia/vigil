import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { reservations } from "../schema/intents";
import { openExecutionAttempt, recordAttemptOutcome } from "./execution-store";
import { recordApprovedIntent } from "./intent-store";
import { loadBalances, loadJournalEntries, postJournalEntry } from "./journal-store";
import {
  consumeReservation,
  expireReservation,
  loadActiveReservations,
  loadExpiredReservations,
  releaseReservation,
  reserveAvailable,
  type ReserveRequest,
} from "./reservation-store";
import { openAttempt, storeApprovedIntent } from "../test-support/intent-fixtures";
import {
  counterFamily,
  creditOf,
  debitOf,
  fundingEntry,
  heldIn,
  openLedgerTestDb,
  storeEntry,
  TEST_ASSET,
  TEST_PROVENANCE,
  TEST_SCALE,
} from "../test-support/journal-fixtures";

// The defects this file kills:
//   * a reservation that is written but never reflected in the balances it
//     is supposed to hold, so the same funds look spendable twice;
//   * a retried request that holds the funds a second time;
//   * a refused request that still leaves a partial write behind;
//   * a hold whose funds the journal has already given back but whose row
//     still reads `active`, so `loadActiveReservations` reports capital the
//     ledger says is free;
//   * a hold on a cancelled intent that never filled, sitting `active`
//     forever because nothing anywhere can end it;
//   * a terminal hold that still blocks its intent's next attempt, which is
//     the retry the partial unique index is partial in order to allow;
//   * a hold handed back while the venue could still fill the order it
//     backs — the one that gives the same base units to two intents;
//   * a hold handed back a second time, or at a size the journal says it no
//     longer covers.
//
// The real-infrastructure fact these claims need is a transaction: every one
// of them is about what survives a commit or a rollback, which an in-memory
// store cannot answer for.

const { db, close, reset } = openLedgerTestDb("vigil-reservation-test");

const FUNDED_BASE = 1_000_000_000n;

function request(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    reservationId: "reservation-1",
    intentId: "intent-1",
    attempt: 1,
    idempotencyKey: "idem-reservation-1",
    correlationId: "corr-reservation-1",
    entryId: "entry-hold-1",
    assetId: TEST_ASSET,
    scale: TEST_SCALE,
    amountBase: 600_000_000n,
    occurredAt: "2026-01-02T03:05:00.000Z",
    recordedAt: "2026-01-02T03:05:01.000Z",
    expiresAt: "2026-01-02T03:10:00.000Z",
    provenance: TEST_PROVENANCE,
    ...overrides,
  };
}

afterAll(close);

beforeEach(async () => {
  await reset();
  const funded = await postJournalEntry(db, fundingEntry("entry-funding", FUNDED_BASE));
  expect(funded.outcome).toBe("posted");
});

async function availableBase(): Promise<bigint> {
  const balances = await loadBalances(db);
  const row = balances.find((balance) => balance.accountKey === `holdings/available/${TEST_ASSET}`);
  return row === undefined ? 0n : row.debitBase - row.creditBase;
}

/** The funded account, untouched: the assertion a rolled-back attempt owes. */
async function expectNothingWritten(): Promise<void> {
  expect(await availableBase()).toBe(FUNDED_BASE);
  expect(await loadJournalEntries(db)).toHaveLength(1);
  expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(0);
}

describe("reserveAvailable", () => {
  it("moves the requested base units from available to reserved and records the hold — catches a reservation written as a row with no effect on the balance it claims to hold", async () => {
    const result = await reserveAvailable(db, request());

    expect(result.outcome).toBe("reserved");
    if (result.outcome === "reserved") {
      expect(result.availableBeforeBase).toBe(FUNDED_BASE);
      expect(result.availableAfterBase).toBe(400_000_000n);
    }

    expect(await availableBase()).toBe(400_000_000n);

    const balances = await loadBalances(db);
    const reserved = balances.find((balance) => balance.accountKey === `holdings/reserved/${TEST_ASSET}`);
    expect(reserved?.debitBase).toBe(600_000_000n);

    const held = await loadActiveReservations(db, TEST_ASSET);
    expect(held).toHaveLength(1);
    expect(held[0]?.amountBase).toBe(600_000_000n);
  });

  it("holds the funds once when the same request is delivered twice — catches an at-least-once dispatcher reserving the same capital for one intent twice over", async () => {
    const first = await reserveAvailable(db, request());
    const replay = await reserveAvailable(db, request({ reservationId: "reservation-replay", entryId: "entry-hold-replay" }));

    expect(first.outcome).toBe("reserved");
    expect(replay.outcome).toBe("duplicate");
    if (replay.outcome === "duplicate") {
      expect(replay.reservationId).toBe("reservation-1");
    }

    expect(await availableBase()).toBe(400_000_000n);
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
  });

  it("refuses a request larger than the available balance and writes nothing at all — catches a refusal that has already posted its hold, or left an empty balance row, before deciding", async () => {
    const result = await reserveAvailable(db, request({ amountBase: FUNDED_BASE + 1n }));

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("INSUFFICIENT_AVAILABLE");
      expect(result.availableBase).toBe(FUNDED_BASE);
    }

    expect(await availableBase()).toBe(FUNDED_BASE);
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(0);
    // Only the funding entry exists: the refused attempt rolled back whole.
    expect(await loadJournalEntries(db)).toHaveLength(1);
    const balances = await loadBalances(db);
    expect(balances.map((balance) => balance.accountKey)).not.toContain(`holdings/reserved/${TEST_ASSET}`);
  });

  it("reserves exactly the available balance and leaves nothing behind — catches the store's own feasibility check written as `<=`, which would strand the last base unit of every asset permanently unreservable", async () => {
    const result = await reserveAvailable(db, request({ amountBase: FUNDED_BASE }));

    expect(result.outcome).toBe("reserved");
    if (result.outcome === "reserved") {
      expect(result.availableBeforeBase).toBe(FUNDED_BASE);
      expect(result.availableAfterBase).toBe(0n);
    }
    expect(await availableBase()).toBe(0n);
  });

  it("refuses a reservation of zero base units under the row lock and writes nothing — catches an empty or sign-flipped request reaching the journal as a hold that authorizes nothing while still consuming the intent's one attempt number", async () => {
    const result = await reserveAvailable(db, request({ amountBase: 0n }));

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("MALFORMED_ENTRY");
      expect(result.availableBase).toBe(FUNDED_BASE);
    }
    await expectNothingWritten();
  });

  it("refuses a hold whose expiry is not after the event it authorizes, and rolls the whole attempt back — @vigil/ledger refuses that window in its pure planner, but nothing stops a store caller from skipping the planner, so the reservations_window check constraint is what actually holds; catches a driver error surfacing as a crash instead of a diagnostic", async () => {
    const result = await reserveAvailable(db, request({ expiresAt: "2026-01-02T03:05:00.000Z" }));

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("CONSTRAINT_VIOLATION");
      expect(result.detail).toContain("reservations_window");
    }
    await expectNothingWritten();
  });

  it("refuses a second live hold on one intent even under a fresh attempt number, and holds the funds once — catches the defect that (intent_id, attempt) uniqueness alone leaves open: a caller whose first attempt timed out retries as attempt 2, nothing requires attempt 1 to be finished, and the intent ends up holding the capital twice", async () => {
    const first = await reserveAvailable(db, request({ amountBase: 100_000_000n }));
    const retryWhileLive = await reserveAvailable(
      db,
      request({
        reservationId: "reservation-3",
        entryId: "entry-hold-3",
        idempotencyKey: "idem-reservation-3",
        attempt: 2,
        amountBase: 100_000_000n,
      }),
    );

    expect(first.outcome).toBe("reserved");
    expect(retryWhileLive.outcome).toBe("refused");
    if (retryWhileLive.outcome === "refused") {
      expect(retryWhileLive.code).toBe("INTENT_ALREADY_HELD");
      // Refused by a unique index after the transaction rolled back, so no
      // balance was measured under a lock. Reporting 0 here would read as
      // "the account is empty" — it is not; it holds 900,000,000.
      expect(retryWhileLive.availableBase).toBeNull();
    }

    // One hold, one hold's worth of capital committed.
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
    expect(await availableBase()).toBe(900_000_000n);
  });

  it("refuses a second reservation reusing one intent's attempt number — catches a retry treated as a fresh authorization instead of a versioned attempt", async () => {
    const first = await reserveAvailable(db, request({ amountBase: 100_000_000n }));
    const sameAttempt = await reserveAvailable(
      db,
      request({
        reservationId: "reservation-2",
        entryId: "entry-hold-2",
        idempotencyKey: "idem-reservation-2",
        amountBase: 100_000_000n,
      }),
    );

    expect(first.outcome).toBe("reserved");
    expect(sameAttempt.outcome).toBe("refused");
    if (sameAttempt.outcome === "refused") {
      // This row violates both rules at once — same intent while a hold is
      // live, and an attempt number already used — and Postgres does not
      // promise which unique index reports first. Either diagnostic is the
      // same refusal; what must never happen is a second hold. The claim
      // that each index exists is asserted against the migrated database in
      // schema-invariants.int.test.ts.
      expect(["INTENT_ALREADY_HELD", "DUPLICATE_RECORD"]).toContain(sameAttempt.code);
    }
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
    expect(await availableBase()).toBe(900_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Leaving `active`: release, consume, expire, and the sweep's candidate scan.
// ---------------------------------------------------------------------------

const HOLD_BASE = 600_000_000n;
/** After the fixture hold's `expiresAt` of 03:10. */
const AFTER_EXPIRY = "2026-01-02T03:11:00.000Z";

async function reservedBase(): Promise<bigint> {
  const balances = await loadBalances(db);
  const row = balances.find((balance) => balance.accountKey === `holdings/reserved/${TEST_ASSET}`);
  return row === undefined ? 0n : row.debitBase - row.creditBase;
}

async function storedState(reservationId: string): Promise<string> {
  const rows = await db.execute<{ state: string }>(
    sql`select state from ${reservations} where reservation_id = ${reservationId}`,
  );
  return rows.rows[0]?.state ?? "(absent)";
}

function expiry(overrides: Record<string, string> = {}): {
  intentId: string;
  entryId: string;
  occurredAt: string;
  recordedAt: string;
  asOf: string;
} {
  return {
    intentId: "intent-1",
    entryId: "entry-expire-1",
    occurredAt: "2026-01-02T03:10:00.000Z",
    recordedAt: AFTER_EXPIRY,
    asOf: AFTER_EXPIRY,
    ...overrides,
  };
}

/** The approved intent an attempt needs to exist at all. */
async function authorize(): Promise<void> {
  const intent = await recordApprovedIntent(db, storeApprovedIntent("intent-1"));
  expect(intent.outcome).toBe("recorded");
}

describe("expireReservation", () => {
  it("hands an abandoned hold back to available, records the transition, and posts its own append-only release — catches the divergence this whole family exists to close: a hold whose capital nothing can ever return, reported as committed forever", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));

    const expired = await expireReservation(db, expiry());

    expect(expired).toEqual({
      outcome: "transitioned",
      reservationId: "reservation-1",
      state: "expired",
      releasedBase: HOLD_BASE,
      entryId: "entry-expire-1",
    });
    expect(await availableBase()).toBe(FUNDED_BASE);
    expect(await reservedBase()).toBe(0n);
    expect(await storedState("reservation-1")).toBe("expired");
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(0);

    const release = (await loadJournalEntries(db)).find((entry) => entry.entryId === "entry-expire-1");
    // A `reservation-release`, not a `reversal`: an expired hold is not a
    // hold posted in error, and recording it as one would both erase the
    // fact that capital really was committed and spend the hold entry's one
    // correction slot.
    expect(release?.kind).toBe("reservation-release");
    expect(release?.reversesEntryId).toBeNull();
    expect(release?.intentId).toBe("intent-1");
    // `occurred_at` is when the window closed, not when the sweep noticed —
    // a sweep that ran late records the same economic instant.
    expect(release?.occurredAt).toBe("2026-01-02T03:10:00.000Z");
    expect(release?.recordedAt).toBe(AFTER_EXPIRY);
  });

  it("answers a redelivered sweep with a no-op instead of releasing the capital twice — catches a second sweep pass, or a retried one, paying the same hold back into available again", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await expireReservation(db, expiry());

    const redelivered = await expireReservation(db, expiry({ entryId: "entry-expire-again" }));

    expect(redelivered).toEqual({ outcome: "noop", reservationId: "reservation-1", state: "expired" });
    expect(await availableBase()).toBe(FUNDED_BASE);
    // Three entries: the funding, the hold, and exactly one release.
    expect(await loadJournalEntries(db)).toHaveLength(3);
  });

  it("frees the intent's next attempt once the hold is terminal — catches a partial unique index that is partial for nothing, because no state transition ever lets an intent past its first hold", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await expireReservation(db, expiry());

    const retry = await reserveAvailable(
      db,
      request({
        reservationId: "reservation-2",
        entryId: "entry-hold-2",
        idempotencyKey: "idem-reservation-2",
        attempt: 2,
        amountBase: HOLD_BASE,
      }),
    );

    expect(retry.outcome).toBe("reserved");
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
    expect(await reservedBase()).toBe(HOLD_BASE);
  });

  it("refuses a hold whose window has not closed and leaves it exactly where it was — catches a sweep that decides expiry from its own arrival rather than from the instant it was asked about", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));

    const early = await expireReservation(db, expiry({ asOf: "2026-01-02T03:09:59.999Z" }));

    expect(early.outcome).toBe("refused");
    if (early.outcome === "refused") {
      expect(early.code).toBe("RESERVATION_NOT_EXPIRED");
    }
    expect(await storedState("reservation-1")).toBe("active");
    expect(await reservedBase()).toBe(HOLD_BASE);
    expect(await loadJournalEntries(db)).toHaveLength(2);
  });

  it("leaves a hold standing while an attempt on its intent is unresolved, UNKNOWN included — catches the sweep handing the same base units to a second intent while the venue can still fill the first, which docs/resilience.md §3 forbids", async () => {
    await authorize();
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const whileSubmitting = await expireReservation(db, expiry());

    const wentUnknown = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "UNKNOWN",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:10:30.000Z",
      recordedAt: "2026-01-02T03:10:30.100Z",
      reconciliation: null,
    });
    const whileUnknown = await expireReservation(db, expiry({ entryId: "entry-expire-unknown" }));

    expect(wentUnknown.outcome).toBe("recorded");
    for (const refusal of [whileSubmitting, whileUnknown]) {
      expect(refusal.outcome).toBe("refused");
      if (refusal.outcome === "refused") {
        expect(refusal.code).toBe("INTENT_ATTEMPT_LIVE");
      }
    }
    // The point of the refusal is the money, not the code: the hold is still
    // held and nothing was posted against it.
    expect(await reservedBase()).toBe(HOLD_BASE);
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
    expect(await loadJournalEntries(db)).toHaveLength(2);
  });

  it("refuses to sweep a hold the venue has already spent from, leaving its settlement to unwind it — catches a sweep releasing the whole hold beside a settlement that has already handed part of it to the venue, which pays out base units twice", async () => {
    await authorize();
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "FILLED",
      spentBase: 400_000_000n,
      receivedBase: 480_000_000n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:07:00.000Z",
      recordedAt: "2026-01-02T03:07:00.100Z",
      reconciliation: null,
    });

    const swept = await expireReservation(db, expiry());

    expect(swept.outcome).toBe("refused");
    if (swept.outcome === "refused") {
      expect(swept.code).toBe("INTENT_ALREADY_SPENT");
    }
    expect(await reservedBase()).toBe(HOLD_BASE);
    expect(await loadJournalEntries(db)).toHaveLength(2);
  });

  it("refuses to release a hold at full size once the journal says part of it is gone, whatever the row still claims — catches a settlement that posted its trade and died before its release, where a later sweep would hand back base units the venue already took", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    // The trade half of a settlement, with its release never posted.
    const spent = await postJournalEntry(db, {
      ...storeEntry("entry-half-spent", "trade", [
        creditOf(heldIn("reserved"), 200_000_000n),
        debitOf(counterFamily("exchange"), 200_000_000n),
      ]),
      intentId: "intent-1",
    });
    expect(spent.outcome).toBe("posted");

    const swept = await expireReservation(db, expiry());

    expect(swept.outcome).toBe("refused");
    if (swept.outcome === "refused") {
      expect(swept.code).toBe("HOLD_ALREADY_UNWOUND");
      expect(swept.detail).toContain("400000000");
    }
    expect(await reservedBase()).toBe(HOLD_BASE - 200_000_000n);
    expect(await storedState("reservation-1")).toBe("active");
  });
});

describe("releaseReservation", () => {
  it("hands a hold back inside its own window and records it as released — catches a cancellation that gives the capital back in the ledger while the reservation record goes on claiming it", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));

    const released = await releaseReservation(db, {
      intentId: "intent-1",
      entryId: "entry-release-1",
      occurredAt: "2026-01-02T03:06:00.000Z",
      recordedAt: "2026-01-02T03:06:00.000Z",
    });

    expect(released).toEqual({
      outcome: "transitioned",
      reservationId: "reservation-1",
      state: "released",
      releasedBase: HOLD_BASE,
      entryId: "entry-release-1",
    });
    expect(await availableBase()).toBe(FUNDED_BASE);
    expect(await reservedBase()).toBe(0n);
    expect(await storedState("reservation-1")).toBe("released");
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(0);
  });

  it("refuses to move a hold that is already terminal in some other state — catches a terminal state being re-decided, so one hold could be recorded as both released and expired", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await releaseReservation(db, {
      intentId: "intent-1",
      entryId: "entry-release-1",
      occurredAt: "2026-01-02T03:06:00.000Z",
      recordedAt: "2026-01-02T03:06:00.000Z",
    });

    const thenExpired = await expireReservation(db, expiry());

    expect(thenExpired.outcome).toBe("refused");
    if (thenExpired.outcome === "refused") {
      expect(thenExpired.code).toBe("RESERVATION_NOT_ACTIVE");
      expect(thenExpired.detail).toContain("released");
    }
    expect(await storedState("reservation-1")).toBe("released");
    expect(await availableBase()).toBe(FUNDED_BASE);
    // The funding, the hold, and one release — not two.
    expect(await loadJournalEntries(db)).toHaveLength(3);
  });

  it("refuses when no reservation names the intent at all — catches a release inventing a hold, which would credit available out of nothing", async () => {
    const missing = await releaseReservation(db, {
      intentId: "intent-nobody",
      entryId: "entry-release-nobody",
      occurredAt: "2026-01-02T03:06:00.000Z",
      recordedAt: "2026-01-02T03:06:00.000Z",
    });

    expect(missing.outcome).toBe("refused");
    if (missing.outcome === "refused") {
      expect(missing.code).toBe("RESERVATION_NOT_FOUND");
    }
    await expectNothingWritten();
  });
});

describe("consumeReservation", () => {
  it("records a spent hold as consumed without posting anything, because the settlement's own entries already moved every base unit — catches a transition that journals the release a second time on top of the settlement that already made it", async () => {
    await authorize();
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "FILLED",
      spentBase: 400_000_000n,
      receivedBase: 480_000_000n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:07:00.000Z",
      recordedAt: "2026-01-02T03:07:00.100Z",
      reconciliation: null,
    });
    // What settle.ts posts: the spend out of reserved, then the remainder back.
    await postJournalEntry(db, {
      ...storeEntry("entry-trade", "trade", [
        creditOf(heldIn("reserved"), 400_000_000n),
        debitOf(counterFamily("exchange"), 400_000_000n),
      ]),
      intentId: "intent-1",
    });
    await postJournalEntry(db, {
      ...storeEntry("entry-settle-release", "reservation-release", [
        debitOf(heldIn("available"), HOLD_BASE - 400_000_000n),
        creditOf(heldIn("reserved"), HOLD_BASE - 400_000_000n),
      ]),
      intentId: "intent-1",
    });
    const entriesBefore = (await loadJournalEntries(db)).length;

    const consumed = await consumeReservation(db, { intentId: "intent-1" });

    expect(consumed).toEqual({
      outcome: "transitioned",
      reservationId: "reservation-1",
      state: "consumed",
      releasedBase: 0n,
      entryId: null,
    });
    expect(await loadJournalEntries(db)).toHaveLength(entriesBefore);
    // The acceptance criterion: the projection and the ledger now agree.
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(0);
    expect(await reservedBase()).toBe(0n);
    expect(await availableBase()).toBe(FUNDED_BASE - 400_000_000n);
  });

  it("refuses to call a hold consumed when no attempt confirmed a spend — catches a settlement path marking an unfilled authorization's hold consumed, which retires capital nothing ever spent", async () => {
    await authorize();
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "CANCELED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:06:00.000Z",
      recordedAt: "2026-01-02T03:06:00.100Z",
      reconciliation: null,
    });

    const consumed = await consumeReservation(db, { intentId: "intent-1" });

    expect(consumed.outcome).toBe("refused");
    if (consumed.outcome === "refused") {
      expect(consumed.code).toBe("INTENT_NOTHING_SPENT");
    }
    expect(await storedState("reservation-1")).toBe("active");
    expect(await loadActiveReservations(db, TEST_ASSET)).toHaveLength(1);
  });
});

describe("loadExpiredReservations", () => {
  it("offers only holds whose window has closed at the instant asked about, oldest first — catches a scan that reads the database clock and so sweeps a hold no caller asked it to", async () => {
    await reserveAvailable(db, request({ amountBase: 100_000_000n, expiresAt: "2026-01-02T03:20:00.000Z" }));
    await reserveAvailable(
      db,
      request({
        reservationId: "reservation-early",
        entryId: "entry-hold-early",
        idempotencyKey: "idem-reservation-early",
        intentId: "intent-early",
        amountBase: 100_000_000n,
        expiresAt: "2026-01-02T03:06:00.000Z",
      }),
    );

    const beforeEither = await loadExpiredReservations(db, { asOf: "2026-01-02T03:05:30.000Z" });
    const afterFirst = await loadExpiredReservations(db, { asOf: "2026-01-02T03:06:00.000Z" });
    const afterBoth = await loadExpiredReservations(db, { asOf: "2026-01-02T03:21:00.000Z" });

    expect(beforeEither).toEqual({ outcome: "scanned", holds: [] });
    expect(afterFirst.outcome === "scanned" ? afterFirst.holds.map((hold) => hold.reservationId) : afterFirst).toEqual([
      "reservation-early",
    ]);
    expect(afterBoth.outcome === "scanned" ? afterBoth.holds.map((hold) => hold.reservationId) : afterBoth).toEqual([
      "reservation-early",
      "reservation-1",
    ]);
  });

  it("stops offering a hold the moment it reaches a terminal state — catches a sweep that keeps re-examining holds it already ended, and would grow a backlog that never drains", async () => {
    await reserveAvailable(db, request({ amountBase: HOLD_BASE }));
    await expireReservation(db, expiry());

    const scan = await loadExpiredReservations(db, { asOf: AFTER_EXPIRY });

    expect(scan).toEqual({ outcome: "scanned", holds: [] });
  });

  it("answers a malformed instant with a reason code rather than a throw — catches schema-legal input reaching the caller as an exception (docs/resilience.md §4)", async () => {
    const refused = await loadExpiredReservations(db, { asOf: "2026-02-30T00:00:00.000Z" });

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.code).toBe("INVALID_INSTANT");
    }
  });
});
