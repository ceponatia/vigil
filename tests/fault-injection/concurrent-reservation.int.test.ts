import {
  assetScales,
  createDbClient,
  journalEntries,
  journalLines,
  ledgerBalances,
  loadActiveReservations,
  loadBalances,
  loadJournalEntries,
  postJournalEntry,
  reservations,
  reserveAvailable,
  type DbClient,
  type ReserveRequest,
  type StoreEntry,
  type StoreProvenance,
} from "@vigil/db";
import { assetIdSchema } from "@vigil/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Acceptance scenario: "Two strategies try to spend the same funds" —
// atomic reservation permits only feasible aggregate spending
// (docs/testing.md, Capital and reservations; issue #6, BOOT-04).
//
// The defect this kills: two processes each check a balance they read a
// moment ago, each find their own request affordable, and both commit. Pure
// arithmetic cannot catch that — only a lock the second transaction has to
// wait on can — so this suite drives two real connections at one balance.
//
// The real-infrastructure facts required: two independent connections, a row
// lock, and a committed transaction boundary. Replacing Postgres with an
// in-memory store would delete the claim rather than move it.

const ASSET = assetIdSchema.parse("1337|native|VGLSTABLE|SYNTHETIC_TESTNET");
const SCALE = 6;
const FUNDED_BASE = 1_000_000_000n;
const HALF_PLUS_BASE = 600_000_000n;

/** Synthetic provenance; both strategies run under the same policy version. */
const CONTENDED_PROVENANCE: StoreProvenance = {
  policyVersion: "policy-contended-0",
  strategyVersion: "strategy-contended-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

const connectionString = process.env.DATABASE_URL ?? "";
const strategyOne: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-strategy-one" });
const strategyTwo: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-strategy-two" });

function fundingEntry(): StoreEntry {
  return {
    entryId: "contended-funding",
    kind: "contribution",
    occurredAt: "2026-04-01T00:00:00.000Z",
    recordedAt: "2026-04-01T00:00:00.000Z",
    correlationId: "corr-contended-funding",
    idempotencyKey: "idem-contended-funding",
    intentId: null,
    reversesEntryId: null,
    provenance: CONTENDED_PROVENANCE,
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

function contendingRequest(strategy: string, amountBase: bigint): ReserveRequest {
  return {
    reservationId: `reservation-${strategy}`,
    intentId: `intent-${strategy}`,
    attempt: 1,
    idempotencyKey: `idem-${strategy}`,
    correlationId: `corr-${strategy}`,
    entryId: `entry-hold-${strategy}`,
    assetId: ASSET,
    scale: SCALE,
    amountBase,
    occurredAt: "2026-04-01T00:01:00.000Z",
    recordedAt: "2026-04-01T00:01:01.000Z",
    expiresAt: "2026-04-01T00:06:00.000Z",
    provenance: CONTENDED_PROVENANCE,
  };
}

afterAll(async () => {
  await strategyOne.close();
  await strategyTwo.close();
});

beforeEach(async () => {
  await strategyOne.db.execute(
    sql`truncate table ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances}, ${assetScales} restart identity cascade`,
  );
  const funded = await postJournalEntry(strategyOne.db, fundingEntry());
  expect(funded.outcome).toBe("posted");

  // Both pools connect lazily. Without this, the second strategy's first
  // query includes a TCP connect and authentication handshake, which is
  // easily long enough for the first strategy's whole transaction to commit
  // — the two calls would then be sequential, and the race this suite exists
  // to run would never actually happen.
  await Promise.all([strategyOne.db.execute(sql`select 1`), strategyTwo.db.execute(sql`select 1`)]);
});

async function availableAndReserved(): Promise<{ available: bigint; reserved: bigint }> {
  const balances = await loadBalances(strategyOne.db);
  const net = (state: string): bigint => {
    const row = balances.find((balance) => balance.accountKey === `holdings/${state}/${ASSET}`);
    return row === undefined ? 0n : row.debitBase - row.creditBase;
  };
  return { available: net("available"), reserved: net("reserved") };
}

describe("two strategies reserving the same funds", () => {
  it("lets only a feasible aggregate be reserved when both requests are in flight at once — catches a feasibility check made against a balance read before the other transaction committed", async () => {
    const [first, second] = await Promise.all([
      reserveAvailable(strategyOne.db, contendingRequest("one", HALF_PLUS_BASE)),
      reserveAvailable(strategyTwo.db, contendingRequest("two", HALF_PLUS_BASE)),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["refused", "reserved"]);

    const refused = first.outcome === "refused" ? first : second.outcome === "refused" ? second : null;
    expect(refused).not.toBeNull();
    if (refused !== null && refused.outcome === "refused") {
      expect(refused.code).toBe("INSUFFICIENT_AVAILABLE");
      // This figure is what separates the two ways the aggregate could have
      // stayed feasible. The loser reporting the *remaining* balance means it
      // waited on the row lock, re-read what the winner committed, and
      // decided against it. A refusal that had instead bounced off the
      // holdings check constraint would carry no measured balance at all.
      expect(refused.availableBase).toBe(FUNDED_BASE - HALF_PLUS_BASE);
    }

    const { available, reserved } = await availableAndReserved();
    expect(reserved).toBe(HALF_PLUS_BASE);
    expect(available).toBe(FUNDED_BASE - HALF_PLUS_BASE);
    // The aggregate is feasible: nothing was reserved that the account did
    // not hold.
    expect(reserved).toBeLessThanOrEqual(FUNDED_BASE);
    expect(available + reserved).toBe(FUNDED_BASE);

    const held = await loadActiveReservations(strategyOne.db, ASSET);
    expect(held).toHaveLength(1);
    // Exactly one hold posting: the refused attempt left no journal entry.
    expect(await loadJournalEntries(strategyOne.db)).toHaveLength(2);
  });

  it("lets both through when the aggregate does fit — catches a lock so coarse that any second reservation fails, which would serialize the allocator into uselessness", async () => {
    const [first, second] = await Promise.all([
      reserveAvailable(strategyOne.db, contendingRequest("one", 400_000_000n)),
      reserveAvailable(strategyTwo.db, contendingRequest("two", 400_000_000n)),
    ]);

    expect(first.outcome).toBe("reserved");
    expect(second.outcome).toBe("reserved");

    const { available, reserved } = await availableAndReserved();
    expect(reserved).toBe(800_000_000n);
    expect(available).toBe(200_000_000n);

    expect(await loadActiveReservations(strategyOne.db, ASSET)).toHaveLength(2);
  });

  it("refuses a third request once the first two have consumed the balance — catches a hold that is durable for the winner but invisible to the next caller", async () => {
    await reserveAvailable(strategyOne.db, contendingRequest("one", 500_000_000n));
    await reserveAvailable(strategyTwo.db, contendingRequest("two", 500_000_000n));

    const third = await reserveAvailable(strategyOne.db, contendingRequest("three", 1n));

    expect(third.outcome).toBe("refused");
    if (third.outcome === "refused") {
      expect(third.code).toBe("INSUFFICIENT_AVAILABLE");
      expect(third.availableBase).toBe(0n);
    }
  });
});
