import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { approvedIntents } from "../schema/intents";
import { storeCandidate } from "../test-support/decision-fixtures";
import { storeApprovedIntent, TEST_OTHER_SCALE } from "../test-support/intent-fixtures";
import { openLedgerTestDb, TEST_ASSET, TEST_OTHER_ASSET, TEST_SCALE } from "../test-support/journal-fixtures";
import { recordCandidate } from "./decision-store";
import {
  loadApprovedIntent,
  loadApprovedIntentsByCorrelation,
  recordApprovedIntent,
  type IntentProvenance,
} from "./intent-store";
import { postgresErrorCode, PG_RAISE_EXCEPTION } from "./pg-errors";

// The defects this file kills:
//   * the same approved proposal, delivered twice by an at-least-once
//     producer, authorizing two spends;
//   * an approved intent whose spending cap, expiry, or receipt floor can be
//     edited after policy approved it — the single thing the
//     `ApprovedEconomicIntent` contract says must never happen;
//   * an authorization that outlives its window, names a candidate nobody
//     journaled, or routes over a chain with no simulation that passed;
//   * a base-unit amount that does not survive the round trip exactly,
//     which is how a float reaches a spending limit.
//
// The real-infrastructure fact these claims need is the migrated schema
// itself: every one of them is about what the database refuses, which an
// in-memory store cannot answer for.

const { db, close, reset } = openLedgerTestDb("vigil-intent-test");

afterAll(close);
beforeEach(reset);

async function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

async function countIntents(): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`select count(*)::text as count from ${approvedIntents}`);
  return Number(rows.rows[0]?.count ?? "-1");
}

describe("recordApprovedIntent", () => {
  it("records the authorization and reads every field back exactly — catches a base-unit cap or receipt floor that loses digits on the round trip, which is how a float reaches a spending limit", async () => {
    const intent = storeApprovedIntent("intent-round-trip", {
      input: {
        assetId: TEST_ASSET,
        scale: TEST_SCALE,
        // More digits than a float64 holds exactly, and more than a bigint
        // column would: the base-unit column is numeric(78, 0).
        maxSpendBase: 123_456_789_012_345_678_901_234_567_890n,
        permittedResidualBase: 999_999_999_999_999_999_999n,
      },
    });

    const recorded = await recordApprovedIntent(db, intent);
    expect(recorded).toEqual({ outcome: "recorded", intentId: "intent-round-trip" });

    expect(await loadApprovedIntent(db, "intent-round-trip")).toEqual(intent);
  });

  it("authorizes one spend when the same idempotency key is delivered twice, and reports the second as a duplicate rather than throwing — catches an at-least-once dispatcher turning one approved proposal into two authorizations", async () => {
    const first = await recordApprovedIntent(db, storeApprovedIntent("intent-once"));
    const second = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-once-again", { idempotencyKey: "idem-intent-once" }),
    );

    expect(first).toEqual({ outcome: "recorded", intentId: "intent-once" });
    expect(second).toEqual({ outcome: "duplicate", intentId: "intent-once" });
    expect(await countIntents()).toBe(1);
    expect(await loadApprovedIntent(db, "intent-once-again")).toBeNull();
  });

  it("refuses a second authorization claiming one economic action id — catches two intents that each believe they are the one authorization for the same economic action", async () => {
    await recordApprovedIntent(db, storeApprovedIntent("intent-econ-a"));
    const clash = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-econ-b", { economicActionId: "econ-intent-econ-a" }),
    );

    expect(clash).toMatchObject({ outcome: "refused", code: "DUPLICATE_RECORD" });
    expect(await countIntents()).toBe(1);
  });

  it("refuses an authorization that does not expire after it was granted, and writes nothing — catches a validity window that authorizes a spend forever", async () => {
    const refused = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-window", { validUntil: "2026-01-02T03:00:00.000Z" }),
    );

    expect(refused).toMatchObject({ outcome: "refused", code: "INVALID_WINDOW" });
    expect(await countIntents()).toBe(0);
  });

  it("refuses an authorization that names a candidate nobody journaled — catches a spend authorized against a decision that was never recorded, which is an authorization no later comparison can attribute", async () => {
    const refused = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-orphan", { candidateId: "candidate-never-written" }),
    );

    expect(refused).toMatchObject({ outcome: "refused", code: "UNKNOWN_CANDIDATE" });
    expect(await countIntents()).toBe(0);
  });

  it("records an authorization that names a journaled candidate — catches a foreign key so strict that the ordinary entry path cannot write at all", async () => {
    const candidate = await recordCandidate(db, storeCandidate("candidate-linked"));
    expect(candidate).toEqual({ outcome: "recorded", candidateId: "candidate-linked" });

    const recorded = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-linked", { candidateId: "candidate-linked" }),
    );

    expect(recorded).toEqual({ outcome: "recorded", intentId: "intent-linked" });
    expect((await loadApprovedIntent(db, "intent-linked"))?.candidateId).toBe("candidate-linked");
  });

  it("refuses an on-chain authorization with no simulation that passed — catches an intent reaching POLICY_VALIDATED without the SIMULATED step docs/architecture.md puts before it", async () => {
    const noSimulation = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-chain-a", { chainId: "1337", chainValidation: null }),
    );
    const failedSimulation = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-chain-b", {
        chainId: "1337",
        chainValidation: { simulationId: "sim-1", passed: false },
      }),
    );

    expect(noSimulation).toMatchObject({ outcome: "refused", code: "INVALID_CHAIN_VALIDATION" });
    expect(failedSimulation).toMatchObject({ outcome: "refused", code: "INVALID_CHAIN_VALIDATION" });
    expect(await countIntents()).toBe(0);
  });

  it("refuses an asset used at a second scale — catches two authorizations that disagree about how many decimal places one asset has, after which their amounts cannot be compared at all", async () => {
    await recordApprovedIntent(db, storeApprovedIntent("intent-scale-a"));

    const refused = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-scale-b", {
        input: { assetId: TEST_ASSET, scale: TEST_SCALE + 1, maxSpendBase: 1_000n, permittedResidualBase: 0n },
      }),
    );

    expect(refused).toMatchObject({ outcome: "refused", code: "SCALE_MISMATCH" });
    expect(await countIntents()).toBe(1);
  });

  const missingStamps: ReadonlyArray<{ readonly field: string; readonly override: Partial<IntentProvenance> }> = [
    { field: "policyVersion", override: { policyVersion: "  " } },
    { field: "feeSnapshotVersion", override: { feeSnapshotVersion: "" } },
    { field: "marketSnapshotVersion", override: { marketSnapshotVersion: "" } },
  ];

  it.each(missingStamps)(
    "refuses an authorization with no $field and writes nothing — catches a spend nobody can attribute to the behavior that sized it",
    async ({ override }) => {
      const intent = storeApprovedIntent("intent-provenance");
      const refused = await recordApprovedIntent(db, {
        ...intent,
        provenance: { ...intent.provenance, ...override },
      });

      expect(refused).toMatchObject({ outcome: "refused", code: "MISSING_PROVENANCE" });
      expect(await countIntents()).toBe(0);
    },
  );

  it("refuses an operating mode that is not one of the four — catches a column that could record an authorization as having been made in a mode this application does not have", async () => {
    const refused = await recordApprovedIntent(db, storeApprovedIntent("intent-mode", { operatingMode: "REAL" }));

    expect(refused).toMatchObject({ outcome: "refused", code: "INVALID_OPERATING_MODE" });
    expect(await countIntents()).toBe(0);
  });

  it("denominates the two sides at their own scales — catches a fixture or a store that reads one asset's scale for both, after which an input/output mix-up passes every other assertion in this package", async () => {
    await recordApprovedIntent(db, storeApprovedIntent("intent-scales"));
    const stored = await loadApprovedIntent(db, "intent-scales");

    expect([stored?.input.assetId, stored?.input.scale]).toEqual([TEST_ASSET, TEST_SCALE]);
    expect([stored?.output.assetId, stored?.output.scale]).toEqual([TEST_OTHER_ASSET, TEST_OTHER_SCALE]);
  });

  it("refuses a residual larger than the spending cap — catches an authorization whose tolerated leftover exceeds everything it was allowed to spend", async () => {
    const refused = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-residual", {
        input: { assetId: TEST_ASSET, scale: TEST_SCALE, maxSpendBase: 1_000n, permittedResidualBase: 1_001n },
      }),
    );

    expect(refused).toMatchObject({ outcome: "refused", code: "INVALID_AMOUNT" });
    expect(await countIntents()).toBe(0);
  });
});

describe("an approved intent is immutable", () => {
  it("rejects an UPDATE against a stored authorization and leaves every field unchanged — this trigger, not the absence of an update function, is what makes the contract's 'immutable once approved' true for a writer that never came through this package", async () => {
    await recordApprovedIntent(db, storeApprovedIntent("intent-frozen"));

    const failure = await errorFrom(() =>
      db.execute(sql`update ${approvedIntents} set max_spend_base = 999999999 where intent_id = 'intent-frozen'`),
    );

    expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);
    expect((await loadApprovedIntent(db, "intent-frozen"))?.input.maxSpendBase).toBe(1_000_000n);
  });

  const rewrites: ReadonlyArray<{ readonly column: string; readonly statement: SQL }> = [
    {
      column: "valid_until",
      statement: sql`update ${approvedIntents} set valid_until = '2099-01-01T00:00:00Z' where intent_id = 'intent-frozen'`,
    },
    {
      column: "venue_id",
      statement: sql`update ${approvedIntents} set venue_id = 'venue-elsewhere' where intent_id = 'intent-frozen'`,
    },
    {
      column: "approval_reason",
      statement: sql`update ${approvedIntents} set approval_reason = 'rewritten' where intent_id = 'intent-frozen'`,
    },
  ];

  it.each(rewrites)(
    "rejects an UPDATE of $column too — catches an immutability guard written as a list of authorizing columns, where the column nobody added to the list is the one that stays mutable",
    async ({ statement }) => {
      await recordApprovedIntent(db, storeApprovedIntent("intent-frozen"));

      const failure = await errorFrom(() => db.execute(statement));

      expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);
    },
  );

  it("rejects a DELETE against a stored authorization — catches a cleanup path that removes the record of what was authorized instead of letting it expire", async () => {
    await recordApprovedIntent(db, storeApprovedIntent("intent-undeletable"));

    const failure = await errorFrom(() =>
      db.execute(sql`delete from ${approvedIntents} where intent_id = 'intent-undeletable'`),
    );

    expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);
    expect(await loadApprovedIntent(db, "intent-undeletable")).not.toBeNull();
  });
});

describe("loadApprovedIntentsByCorrelation", () => {
  it("returns every authorization tied to one correlation id, oldest approval first — catches a reconciliation that can see only the newest intent for a decision that produced several", async () => {
    await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-corr-2", { correlationId: "corr-shared", approvedAt: "2026-01-02T03:30:00.000Z" }),
    );
    await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-corr-1", { correlationId: "corr-shared", approvedAt: "2026-01-02T03:00:00.000Z" }),
    );
    await recordApprovedIntent(db, storeApprovedIntent("intent-corr-other"));

    const found = await loadApprovedIntentsByCorrelation(db, "corr-shared");

    expect(found.map((intent) => intent.intentId)).toEqual(["intent-corr-1", "intent-corr-2"]);
  });
});
