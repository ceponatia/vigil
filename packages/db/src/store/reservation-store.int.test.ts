import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadBalances, loadJournalEntries, postJournalEntry } from "./journal-store";
import { loadActiveReservations, reserveAvailable, type ReserveRequest } from "./reservation-store";
import {
  fundingEntry,
  openLedgerTestDb,
  TEST_ASSET,
  TEST_PROVENANCE,
  TEST_SCALE,
} from "../test-support/journal-fixtures";

// The defects this file kills:
//   * a reservation that is written but never reflected in the balances it
//     is supposed to hold, so the same funds look spendable twice;
//   * a retried request that holds the funds a second time;
//   * a refused request that still leaves a partial write behind.
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
