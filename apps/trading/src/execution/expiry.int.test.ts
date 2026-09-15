import {
  createDbClient,
  loadActiveReservations,
  loadBalances,
  loadExpiredReservations,
  postJournalEntry,
  reserveAvailable,
  EXPIRED_HOLD_SCAN_LIMIT,
  type DbClient,
  type ReserveRequest,
  type StoreEntry,
  type StoreProvenance,
} from "@vigil/db";
import { assetIdSchema } from "@vigil/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepExpiredReservations } from "./expiry";

// The defect this file kills: head-of-line starvation in the expiry sweep.
//
// A hold the sweep refuses stays `active` with an `expires_at` in the past,
// so every later scan offers it again — and, being the oldest, at the head of
// every page. The permanently-refused ones are exactly those the sweep may
// never end, so once a page fills with them, no releasable hold behind them
// is examined again for the life of the process. It is silent: refusals log
// at debug, and a sweep that ends nothing looks like a sweep with nothing to
// do. That is AC4's "within a bounded time" failing under precisely the
// condition the sweep exists to tolerate.
//
// The real-infrastructure facts required are the page size itself and a
// scan the database orders — a fake store would be asserting against this
// suite's own idea of paging rather than the query's.
//
// **This suite never truncates.** `apps/trading` cannot: the truncate list
// lives in `packages/db`'s own test-support, and `journal_entries` is
// append-only by trigger. Instead it is isolated by *time* — every hold here
// expires in 2020, and `loadExpiredReservations` is asked about an instant in
// 2020, so no other suite's rows (all 2024 or later) are in the result set at
// all. Amounts are isolated by a synthetic asset used nowhere else.

const ASSET = assetIdSchema.parse("1337|native|VGLSWEEP55|SYNTHETIC_TESTNET");
const SCALE = 6;
const FUNDED_BASE = 1_000_000_000n;
const STUCK_BASE = 1_000n;
const RELEASABLE_BASE = 5_000n;
/** Enough refusable holds to fill one page exactly. */
const STUCK_HOLDS = EXPIRED_HOLD_SCAN_LIMIT;

const OCCURRED = "2020-01-01T00:00:00.000Z";
/** Every stuck hold shares one expiry, so they sort ahead of the releasable one. */
const STUCK_EXPIRES = "2020-01-01T00:01:00.000Z";
const RELEASABLE_EXPIRES = "2020-01-01T00:02:00.000Z";
const ASOF = "2020-01-01T01:00:00.000Z";

const PROVENANCE: StoreProvenance = {
  policyVersion: "policy-sweep-paging-0",
  strategyVersion: "strategy-sweep-paging-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

const client: DbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  applicationName: "vigil-expiry-paging",
});

const stuckId = (index: number): string => `res-paging-stuck-${String(index).padStart(4, "0")}`;
const RELEASABLE_ID = "res-paging-releasable";

function fundingEntry(): StoreEntry {
  return {
    entryId: "entry-paging-funding",
    kind: "contribution",
    occurredAt: OCCURRED,
    recordedAt: OCCURRED,
    correlationId: "corr-paging-funding",
    idempotencyKey: "idem-paging-funding",
    intentId: null,
    reversesEntryId: null,
    provenance: PROVENANCE,
    lines: [
      { account: { family: "holdings", assetId: ASSET, holdingsState: "available" }, scale: SCALE, amountBase: FUNDED_BASE, direction: "debit" },
      { account: { family: "contributed-capital", assetId: ASSET, holdingsState: null }, scale: SCALE, amountBase: FUNDED_BASE, direction: "credit" },
    ],
  };
}

function holdFor(label: string, amountBase: bigint, expiresAt: string): ReserveRequest {
  return {
    reservationId: label,
    intentId: `intent-${label}`,
    attempt: 1,
    idempotencyKey: `reserve:intent-${label}`,
    correlationId: `corr-${label}`,
    entryId: `entry-hold-${label}`,
    assetId: ASSET,
    scale: SCALE,
    amountBase,
    occurredAt: OCCURRED,
    recordedAt: OCCURRED,
    expiresAt,
    provenance: PROVENANCE,
  };
}

/**
 * Half of one hold's capital taken by a trade whose release never posted —
 * a settlement that died in between. The hold stays `active` and the backing
 * check refuses it every time, which is what makes it permanently stuck.
 */
function partialUnwind(label: string): StoreEntry {
  return {
    entryId: `entry-partial-${label}`,
    kind: "trade",
    occurredAt: OCCURRED,
    recordedAt: OCCURRED,
    correlationId: `corr-${label}`,
    idempotencyKey: `idem-partial-${label}`,
    intentId: `intent-${label}`,
    reversesEntryId: null,
    provenance: PROVENANCE,
    lines: [
      { account: { family: "holdings", assetId: ASSET, holdingsState: "reserved" }, scale: SCALE, amountBase: 400n, direction: "credit" },
      { account: { family: "exchange", assetId: ASSET, holdingsState: null }, scale: SCALE, amountBase: 400n, direction: "debit" },
    ],
  };
}

async function availableBase(): Promise<bigint> {
  const balances = await loadBalances(client.db);
  const row = balances.find((balance) => balance.accountKey === `holdings/available/${ASSET}`);
  return row === undefined ? 0n : row.debitBase - row.creditBase;
}

beforeAll(async () => {
  const funded = await postJournalEntry(client.db, fundingEntry());
  expect(funded.outcome).toBe("posted");

  for (let index = 0; index < STUCK_HOLDS; index += 1) {
    const label = stuckId(index);
    const held = await reserveAvailable(client.db, holdFor(label, STUCK_BASE, STUCK_EXPIRES));
    expect(held.outcome).toBe("reserved");
    const partial = await postJournalEntry(client.db, partialUnwind(label));
    expect(partial.outcome).toBe("posted");
  }

  const releasable = await reserveAvailable(client.db, holdFor(RELEASABLE_ID, RELEASABLE_BASE, RELEASABLE_EXPIRES));
  expect(releasable.outcome).toBe("reserved");
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("one expiry sweep against a full page of holds it can never end", () => {
  it("pages past them within the tick and releases the hold behind them — catches a sweep that takes one page per tick, where a page's worth of permanently-refused holds hides every releasable hold behind it forever, and reports zero expired rather than anything an operator could act on", async () => {
    // The starvation setup, asserted rather than assumed: the hold that can
    // be released is genuinely not reachable on the first page.
    const firstPage = await loadExpiredReservations(client.db, { asOf: ASOF });
    const onFirstPage = firstPage.outcome === "scanned" ? firstPage.holds.map((hold) => hold.reservationId) : [];
    expect(onFirstPage).toHaveLength(EXPIRED_HOLD_SCAN_LIMIT);
    expect(onFirstPage).not.toContain(RELEASABLE_ID);

    const before = await availableBase();
    const summary = await sweepExpiredReservations(client.db, { asOf: ASOF });
    const after = await availableBase();

    expect(summary.expired).toBe(1);
    expect(summary.examined).toBe(STUCK_HOLDS + 1);
    expect(summary.truncated).toBe(false);
    // Exactly the releasable hold's base units, and only for its own asset:
    // base units of different assets are never added together.
    expect(after - before).toBe(RELEASABLE_BASE);
    expect(summary.releasedByAsset.get(ASSET)).toBe(RELEASABLE_BASE);
    expect(summary.releasedByAsset.size).toBe(1);

    // Every stuck hold is refused for the reason that makes it stuck, and is
    // left standing rather than quietly dropped.
    expect(summary.refusals).toHaveLength(STUCK_HOLDS);
    expect([...new Set(summary.refusals.map((refusal) => refusal.code))]).toEqual(["HOLD_ALREADY_UNWOUND"]);

    const stillHeld = await loadActiveReservations(client.db, ASSET);
    expect(stillHeld).toHaveLength(STUCK_HOLDS);
    expect(stillHeld.map((hold) => hold.reservationId)).not.toContain(RELEASABLE_ID);
  }, 60_000);

  it("reaches the end of the backlog on a later pass too, rather than reporting it truncated forever — catches a page budget consumed by re-examining the same refused prefix until nothing new is ever reached", async () => {
    const second = await sweepExpiredReservations(client.db, { asOf: ASOF });

    expect(second.expired).toBe(0);
    expect(second.truncated).toBe(false);
    expect(second.examined).toBe(STUCK_HOLDS);
  }, 60_000);
});
