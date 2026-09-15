import {
  approvedIntents,
  assetScales,
  createDbClient,
  executionAttempts,
  intentCostComponents,
  intentDispatchOutbox,
  loadExecutionAttempts,
  openExecutionAttempt,
  recordApprovedIntent,
  type DbClient,
  type OpenAttemptRequest,
  type StoreApprovedIntent,
} from "@vigil/db";
import { assetIdSchema } from "@vigil/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Acceptance scenario: a fill commits while a retry is being opened
// (docs/architecture.md "Execution lifecycles": a retry is a versioned
// attempt on the same intent, never a new authorization to repeat the
// trade).
//
// The defect this kills, which was reproduced against Postgres 18 before the
// guard that closes it was written: under READ COMMITTED, the trigger that
// refuses a new attempt on an already-consumed intent runs on the opening
// transaction's snapshot. A fill recorded but not yet committed is invisible
// to it, so the check passed; the insert then waited on the one-live-attempt
// index because the filling attempt was still live; and when the fill
// committed, that attempt left the partial index, the wait resolved, and the
// insert succeeded. The trigger does not run again at that point. Attempt 2
// ended up open and dispatchable on an intent whose capital had just been
// spent — and the consumed index would only have refused the row that
// recorded the *second* spend, after the money moved.
//
// The real-infrastructure facts required: two independent connections, an
// uncommitted transaction holding a row lock, and a snapshot boundary.
// Nothing about this claim survives being moved to an in-memory store.

const SPENT_ASSET = assetIdSchema.parse("1337|native|VGLSTABLE|SYNTHETIC_TESTNET");
const ACQUIRED_ASSET = assetIdSchema.parse("1337|native|VGLOTHER|SYNTHETIC_TESTNET");
const SPENT_SCALE = 6;
const ACQUIRED_SCALE = 8;

const connectionString = process.env.DATABASE_URL ?? "";
const filler: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-intent-filler" });
const retrier: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-intent-retrier" });
const observer: DbClient = createDbClient({ connectionString, maxConnections: 2, applicationName: "vigil-intent-observer" });

function contendedIntent(): StoreApprovedIntent {
  return {
    intentId: "intent-contended",
    idempotencyKey: "idem-intent-contended",
    correlationId: "corr-intent-contended",
    economicActionId: "econ-intent-contended",
    positionPlanId: "plan-intent-contended",
    candidateId: null,
    operatingMode: "PAPER",
    fundingAccountId: "account-paper-settlement",
    venueId: "venue-paper",
    chainId: null,
    routeId: null,
    input: { assetId: SPENT_ASSET, scale: SPENT_SCALE, maxSpendBase: 1_000_000n, permittedResidualBase: 1_000n },
    output: {
      assetId: ACQUIRED_ASSET,
      scale: ACQUIRED_SCALE,
      quantityBase: 500_000_000n,
      minAcceptableReceiptBase: 480_000_000n,
    },
    validUntil: "2026-04-01T01:00:00.000Z",
    requiredFreshnessMs: 5_000,
    protectionPlan: null,
    remainingInventoryTreatment: "KEEP",
    benchmarkId: "benchmark-hold-settlement-reserve",
    approvalReason: "inside every limit",
    adapterCapabilityVersion: "adapter-paper-0",
    chainValidation: null,
    approvedAt: "2026-04-01T00:00:00.000Z",
    recordedAt: "2026-04-01T00:00:00.100Z",
    provenance: {
      policyVersion: "policy-contended-0",
      strategyVersion: "strategy-contended-0",
      modelVersion: null,
      portfolioSnapshotVersion: "portfolio-contended-0",
      marketSnapshotVersion: "market-contended-0",
      feeSnapshotVersion: "fee-contended-0",
    },
    economics: {
      quoteId: "quote-contended-0",
      quoteAcquiredAt: "2026-03-31T23:59:59.000Z",
      costModelVersion: "cost-model-contended-0",
      numeraireAssetId: SPENT_ASSET,
      numeraireScale: SPENT_SCALE,
      notionalBase: 1_000_000n,
      expectedGrossBase: 5_100n,
      expectedTotalCostBase: 2_600n,
      expectedNetEdgeBase: 2_500n,
      netEdgeBasis: "hurdle",
      minimumNetEdgeBase: 1_000n,
      costComponents: [
        {
          kind: "proportional-fee",
          chargeBasis: "separately-charged",
          nativeAssetId: SPENT_ASSET,
          nativeScale: SPENT_SCALE,
          nativeAmountBase: 2_600n,
          numeraireAmountBase: 2_600n,
          conversionSource: null,
        },
      ],
    },
  };
}

function attemptRequest(attempt: number): OpenAttemptRequest {
  return {
    attemptId: `att-contended-${attempt}`,
    intentId: "intent-contended",
    attempt,
    clientOrderId: `coid-contended-${attempt}`,
    submittedAt: "2026-04-01T00:10:00.000Z",
    recordedAt: "2026-04-01T00:10:00.100Z",
    dispatch: {
      dispatchId: `disp-contended-${attempt}`,
      payloadDigest: "5f0e".repeat(16),
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 1n,
      enqueuedAt: "2026-04-01T00:10:00.050Z",
    },
  };
}

afterAll(async () => {
  await filler.close();
  await retrier.close();
  await observer.close();
});

beforeEach(async () => {
  await filler.db.execute(
    sql`truncate table ${intentDispatchOutbox}, ${executionAttempts}, ${intentCostComponents}, ${approvedIntents}, ${assetScales} restart identity cascade`,
  );
  const approved = await recordApprovedIntent(filler.db, contendedIntent());
  expect(approved.outcome).toBe("recorded");
  const opened = await openExecutionAttempt(filler.db, attemptRequest(1));
  expect(opened.outcome).toBe("opened");

  // Both pools connect lazily. Without this, the retrier's first query
  // includes a TCP connect and an authentication handshake, which is easily
  // long enough for the filling transaction to commit — the two calls would
  // then be sequential, and the interleaving this suite exists to drive
  // would never happen.
  await Promise.all([retrier.db.execute(sql`select 1`), observer.db.execute(sql`select 1`)]);
});

/**
 * Wait until some backend is blocked on a lock, so the retry is known to be
 * inside the window rather than merely to have been started. Without this
 * the test would still pass with the guard removed, because the fill would
 * usually commit first — and a race test that only ever runs one order is
 * not a race test.
 */
async function waitForBlockedBackend(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await observer.db.execute<{ count: string }>(
      sql`select count(*)::text as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if (Number(blocked.rows[0]?.count ?? "0") > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no backend ever blocked; the concurrent window this suite exists to drive did not open");
}

describe("a fill committing while a retry is opened", () => {
  it("refuses the retry rather than opening a second dispatchable attempt on an intent that was just consumed — catches the consumed-intent check reading a snapshot taken before the fill committed, after which nothing re-checks it and the money can be spent twice", async () => {
    let releaseFill: () => void = () => undefined;
    let fillApplied: () => void = () => undefined;
    const fillHeld = new Promise<void>((resolve) => {
      releaseFill = resolve;
    });
    const fillReady = new Promise<void>((resolve) => {
      fillApplied = resolve;
    });

    // The same UPDATE `recordAttemptOutcome` issues, held inside an explicit
    // transaction so the row lock it takes outlives the statement.
    const filling = filler.db.transaction(async (tx) => {
      await tx
        .update(executionAttempts)
        .set({
          state: "FILLED",
          spentBase: 900_000n,
          receivedBase: 480_000_000n,
          stateChangedAt: new Date("2026-04-01T00:15:00.000Z"),
          recordedAt: new Date("2026-04-01T00:15:00.100Z"),
        })
        .where(and(eq(executionAttempts.intentId, "intent-contended"), eq(executionAttempts.attempt, 1)));
      fillApplied();
      await fillHeld;
    });

    await fillReady;
    const retrying = openExecutionAttempt(retrier.db, attemptRequest(2));
    await waitForBlockedBackend();
    releaseFill();
    await filling;

    const retried = await retrying;

    expect(retried).toMatchObject({ outcome: "refused", code: "INTENT_ALREADY_CONSUMED" });
    const attempts = await observer.db
      .select({ attempt: executionAttempts.attempt, state: executionAttempts.state })
      .from(executionAttempts);
    expect(attempts).toEqual([{ attempt: 1, state: "FILLED" }]);
  });

  it("refuses the retry under either interleaving — catches a guard that only holds when the fill happens to win the race", async () => {
    const [, retried] = await Promise.all([
      filler.db
        .update(executionAttempts)
        .set({
          state: "FILLED",
          spentBase: 900_000n,
          receivedBase: 480_000_000n,
          stateChangedAt: new Date("2026-04-01T00:15:00.000Z"),
          recordedAt: new Date("2026-04-01T00:15:00.100Z"),
        })
        .where(and(eq(executionAttempts.intentId, "intent-contended"), eq(executionAttempts.attempt, 1))),
      openExecutionAttempt(retrier.db, attemptRequest(2)),
    ]);

    // Which refusal depends on who got there first: the retry either found
    // attempt 1 still live, or found the intent already consumed. What it
    // never is, is opened.
    expect(retried.outcome).toBe("refused");
    if (retried.outcome === "refused") {
      expect(["INTENT_ALREADY_LIVE", "INTENT_ALREADY_CONSUMED"]).toContain(retried.code);
    }
    expect(await loadExecutionAttempts(observer.db, "intent-contended")).toHaveLength(1);
  });
});
