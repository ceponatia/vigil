import {
  approvedIntents,
  assetScales,
  createDbClient,
  executionAttempts,
  expireReservation,
  intentCostComponents,
  intentDispatchOutbox,
  journalEntries,
  journalLines,
  ledgerBalances,
  loadActiveReservations,
  loadBalances,
  loadJournalEntries,
  postJournalEntry,
  releaseReservation,
  reservations,
  reserveAvailable,
  type DbClient,
  type ExpireHoldRequest,
  type ReserveRequest,
  type StoreEntry,
  type StoreProvenance,
} from "@vigil/db";
import { assetIdSchema } from "@vigil/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Acceptance scenario: an abandoned hold is given back exactly once, even
// when two runtimes sweep it at the same instant (docs/testing.md, Capital
// and reservations; issue #55).
//
// The defects this kills:
//   * two sweepers that each read `active`, each decide the hold is theirs
//     to end, and each pay its base units back into `available` — capital
//     invented out of a race;
//   * the ledger and `loadActiveReservations` disagreeing after a hold ends,
//     which is the divergence issue #55 exists to close.
//
// A NOTE ON THE SHAPE. Two calls started with `Promise.all` do NOT overlap
// here: the first transaction commits before the second reaches its critical
// section, and a suite written that way passes with every guard removed. So
// this one holds a gate lock on a third connection, waits until both
// contenders are demonstrably blocked on a lock in `pg_stat_activity`, and
// only then opens the gate. The real-infrastructure facts required are three
// independent connections, row locks, and a committed transaction boundary;
// an in-memory store cannot host the claim at all.

const ASSET = assetIdSchema.parse("1337|native|VGLSTABLE|SYNTHETIC_TESTNET");
const SCALE = 6;
const FUNDED_BASE = 1_000_000_000n;
const HOLD_BASE = 600_000_000n;
/** The fixture hold's window closes at 03:10; every sweep below asks about 03:11. */
const AFTER_EXPIRY = "2026-04-01T03:11:00.000Z";

const SWEEP_PROVENANCE: StoreProvenance = {
  policyVersion: "policy-sweep-0",
  strategyVersion: "strategy-sweep-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

const connectionString = process.env.DATABASE_URL ?? "";
const runtimeOne: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-sweep-one" });
const runtimeTwo: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-sweep-two" });
const gateRuntime: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-sweep-gate" });

function fundingEntry(): StoreEntry {
  return {
    entryId: "sweep-funding",
    kind: "contribution",
    occurredAt: "2026-04-01T00:00:00.000Z",
    recordedAt: "2026-04-01T00:00:00.000Z",
    correlationId: "corr-sweep-funding",
    idempotencyKey: "idem-sweep-funding",
    intentId: null,
    reversesEntryId: null,
    provenance: SWEEP_PROVENANCE,
    lines: [
      {
        account: { family: "holdings", assetId: ASSET, holdingsState: "available" },
        scale: SCALE,
        amountBase: FUNDED_BASE,
        direction: "debit",
      },
      {
        account: { family: "contributed-capital", assetId: ASSET, holdingsState: null },
        scale: SCALE,
        amountBase: FUNDED_BASE,
        direction: "credit",
      },
    ],
  };
}

function abandonedHold(): ReserveRequest {
  return {
    reservationId: "reservation-abandoned",
    intentId: "intent-abandoned",
    attempt: 1,
    idempotencyKey: "idem-reservation-abandoned",
    correlationId: "corr-intent-abandoned",
    entryId: "entry-hold-abandoned",
    assetId: ASSET,
    scale: SCALE,
    amountBase: HOLD_BASE,
    occurredAt: "2026-04-01T03:05:00.000Z",
    recordedAt: "2026-04-01T03:05:01.000Z",
    expiresAt: "2026-04-01T03:10:00.000Z",
    provenance: SWEEP_PROVENANCE,
  };
}

function sweepRequest(entryId: string): ExpireHoldRequest {
  return {
    intentId: "intent-abandoned",
    entryId,
    occurredAt: "2026-04-01T03:10:00.000Z",
    recordedAt: AFTER_EXPIRY,
    asOf: AFTER_EXPIRY,
  };
}

afterAll(async () => {
  await runtimeOne.close();
  await runtimeTwo.close();
  await gateRuntime.close();
});

beforeEach(async () => {
  await runtimeOne.db.execute(
    sql`truncate table ${intentDispatchOutbox}, ${executionAttempts}, ${intentCostComponents}, ${approvedIntents}, ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances}, ${assetScales} restart identity cascade`,
  );
  const funded = await postJournalEntry(runtimeOne.db, fundingEntry());
  expect(funded.outcome).toBe("posted");

  // Every pool connects lazily. Without this, a contender's first query
  // includes a TCP connect and an authentication handshake, which is easily
  // long enough for the other transaction to commit — the two calls would
  // then be sequential and the race would never happen.
  await Promise.all([
    runtimeOne.db.execute(sql`select 1`),
    runtimeTwo.db.execute(sql`select 1`),
    gateRuntime.db.execute(sql`select 1`),
  ]);
});

async function holdings(): Promise<{ available: bigint; reserved: bigint }> {
  const balances = await loadBalances(runtimeOne.db);
  const net = (state: string): bigint => {
    const row = balances.find((balance) => balance.accountKey === `holdings/${state}/${ASSET}`);
    return row === undefined ? 0n : row.debitBase - row.creditBase;
  };
  return { available: net("available"), reserved: net("reserved") };
}

/** Backends parked on a lock right now — how the gate proves it is holding. */
async function blockedBackends(): Promise<number> {
  const rows = await runtimeOne.db.execute<{ count: string }>(
    sql`select count(*)::text as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
  );
  return Number(rows.rows[0]?.count ?? "0");
}

async function waitUntilBlocked(want: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await blockedBackends();
    if (seen >= want) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen;
}

type Gate = { readonly held: Promise<void>; readonly open: () => void };

/** Lock the hold's rows on a third connection and hold the transaction open. */
async function gateOnTheHold(): Promise<Gate> {
  let release = (): void => {};
  const gated = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = (): void => {};
  const isHolding = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const held = gateRuntime.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${reservations} where intent_id = 'intent-abandoned' for update`);
    holding();
    await gated;
  });
  // Await the lock, not just the call: starting the contenders before the
  // gate actually holds the row lets them take it first and run in sequence,
  // which is the same nothing-proved shape this suite exists to avoid.
  await isHolding;
  return { held, open: release };
}

describe("two runtimes sweeping one abandoned hold", () => {
  it("hands the capital back exactly once when both sweeps are inside their critical section at the same moment — catches two sweepers each reading `active` and each crediting the same base units back to available, which invents capital out of a race", async () => {
    const held = await reserveAvailable(runtimeOne.db, abandonedHold());
    expect(held.outcome).toBe("reserved");

    const gate = await gateOnTheHold();
    const first = expireReservation(runtimeOne.db, sweepRequest("entry-expire-one"));
    const second = expireReservation(runtimeTwo.db, sweepRequest("entry-expire-two"));

    // Without this the suite would prove nothing: it is the evidence that
    // both sweeps really are contending rather than running in sequence.
    expect(await waitUntilBlocked(2)).toBeGreaterThanOrEqual(2);
    gate.open();
    await gate.held;

    const [one, two] = await Promise.all([first, second]);

    expect([one.outcome, two.outcome].toSorted()).toEqual(["noop", "transitioned"]);
    const winner = one.outcome === "transitioned" ? one : two;
    if (winner.outcome === "transitioned") {
      expect(winner.releasedBase).toBe(HOLD_BASE);
      expect(winner.state).toBe("expired");
    }

    const { available, reserved } = await holdings();
    expect(available).toBe(FUNDED_BASE);
    expect(reserved).toBe(0n);
    // The funding, the hold, and exactly one release: the loser posted
    // nothing at all, rather than posting and being rolled back after the
    // fact.
    expect((await loadJournalEntries(runtimeOne.db)).filter((entry) => entry.kind === "reservation-release")).toHaveLength(
      1,
    );
    expect(await loadActiveReservations(runtimeOne.db, ASSET)).toHaveLength(0);
  });

  it("leaves the hold standing when neither sweep may take it, rather than one of them tearing it down — catches a race resolved by whichever caller arrived first instead of by the hold's own window", async () => {
    await reserveAvailable(runtimeOne.db, abandonedHold());

    const early = { ...sweepRequest("entry-expire-early"), asOf: "2026-04-01T03:09:00.000Z" };
    const [one, two] = await Promise.all([
      expireReservation(runtimeOne.db, early),
      expireReservation(runtimeTwo.db, { ...early, entryId: "entry-expire-early-two" }),
    ]);

    for (const refusal of [one, two]) {
      expect(refusal.outcome).toBe("refused");
      if (refusal.outcome === "refused") {
        expect(refusal.code).toBe("RESERVATION_NOT_EXPIRED");
      }
    }
    const { available, reserved } = await holdings();
    expect(reserved).toBe(HOLD_BASE);
    expect(available).toBe(FUNDED_BASE - HOLD_BASE);
    expect(await loadActiveReservations(runtimeOne.db, ASSET)).toHaveLength(1);
  });
});

describe("an expiry sweep and an explicit release arriving together", () => {
  it("hands the hold back once when two different terminations reach it at the same moment — catches the case the release entry's idempotency key cannot catch, because an expiry and a release post under different keys and would both succeed", async () => {
    await reserveAvailable(runtimeOne.db, abandonedHold());

    const gate = await gateOnTheHold();
    const sweep = expireReservation(runtimeOne.db, sweepRequest("entry-expire-racing"));
    const explicit = releaseReservation(runtimeTwo.db, {
      intentId: "intent-abandoned",
      entryId: "entry-release-racing",
      occurredAt: AFTER_EXPIRY,
      recordedAt: AFTER_EXPIRY,
    });

    expect(await waitUntilBlocked(2)).toBeGreaterThanOrEqual(2);
    gate.open();
    await gate.held;

    const [swept, released] = await Promise.all([sweep, explicit]);

    const winners = [swept, released].filter((result) => result.outcome === "transitioned");
    expect(winners).toHaveLength(1);
    const { available, reserved } = await holdings();
    expect(available).toBe(FUNDED_BASE);
    expect(reserved).toBe(0n);
    // The loser's posting went back with its transaction rather than
    // standing beside the winner's under a different idempotency key.
    expect(
      (await loadJournalEntries(runtimeOne.db)).filter((entry) => entry.kind === "reservation-release"),
    ).toHaveLength(1);
    expect(await loadActiveReservations(runtimeOne.db, ASSET)).toHaveLength(0);
  });
});

describe("the reservation record and the ledger after a hold ends", () => {
  it("agree on what is held, before and after a release — catches the divergence #55 names: the journal has given the capital back and `loadActiveReservations` goes on reporting it as committed", async () => {
    await reserveAvailable(runtimeOne.db, abandonedHold());

    const committedBefore = (await loadActiveReservations(runtimeOne.db, ASSET)).reduce(
      (total, hold) => total + hold.amountBase,
      0n,
    );
    expect(committedBefore).toBe((await holdings()).reserved);

    const released = await releaseReservation(runtimeOne.db, {
      intentId: "intent-abandoned",
      entryId: "entry-release-abandoned",
      occurredAt: "2026-04-01T03:06:00.000Z",
      recordedAt: "2026-04-01T03:06:00.000Z",
    });
    expect(released.outcome).toBe("transitioned");

    const committedAfter = (await loadActiveReservations(runtimeOne.db, ASSET)).reduce(
      (total, hold) => total + hold.amountBase,
      0n,
    );
    const { available, reserved } = await holdings();
    // Both halves matter. The first is the acceptance criterion; the second
    // is what stops it being met by a projection that simply reports nothing.
    expect(committedAfter).toBe(reserved);
    expect(committedAfter).toBe(0n);
    expect(available).toBe(FUNDED_BASE);
  });
});
