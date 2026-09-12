import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type VigilDatabase } from "../client";
import { reservations } from "../schema/intents";
import { journalEntries, journalLines, ledgerBalances } from "../schema/journal";
import { loadBalances, loadJournalEntries, postJournalEntry } from "./journal-store";
import { loadActiveReservations, reserveAvailable, type ReserveRequest } from "./reservation-store";
import { fundingEntry, TEST_ASSET, TEST_SCALE } from "../test-support/journal-fixtures";

// The defects this file kills:
//   * a reservation that is written but never reflected in the balances it
//     is supposed to hold, so the same funds look spendable twice;
//   * a retried request that holds the funds a second time;
//   * a refused request that still leaves a partial write behind.
//
// The real-infrastructure fact these claims need is a transaction: every one
// of them is about what survives a commit or a rollback, which an in-memory
// store cannot answer for.

const client = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  applicationName: "vigil-reservation-test",
});
const db: VigilDatabase = client.db;

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
    ...overrides,
  };
}

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances} restart identity cascade`,
  );
  const funded = await postJournalEntry(db, fundingEntry("entry-funding", FUNDED_BASE));
  expect(funded.outcome).toBe("posted");
});

async function availableBase(): Promise<bigint> {
  const balances = await loadBalances(db);
  const row = balances.find((balance) => balance.accountKey === `holdings|available|${TEST_ASSET}`);
  return row === undefined ? 0n : row.debitBase - row.creditBase;
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
    const reserved = balances.find((balance) => balance.accountKey === `holdings|reserved|${TEST_ASSET}`);
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
    expect(balances.map((balance) => balance.accountKey)).not.toContain(`holdings|reserved|${TEST_ASSET}`);
  });

  it("refuses a second reservation claiming the same attempt number on one intent — catches a retry treated as a fresh authorization instead of a versioned attempt", async () => {
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
      expect(sameAttempt.code).toBe("DUPLICATE_RECORD");
    }
    expect(await availableBase()).toBe(900_000_000n);
  });

  it("permits a second attempt on the same intent under a new attempt number — catches uniqueness written as intent_id alone, which would make a retry impossible after a release", async () => {
    const first = await reserveAvailable(db, request({ amountBase: 100_000_000n }));
    const retry = await reserveAvailable(
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
    expect(retry.outcome).toBe("reserved");
    expect(await availableBase()).toBe(800_000_000n);
  });
});
