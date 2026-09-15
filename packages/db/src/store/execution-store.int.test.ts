import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { executionAttempts, intentDispatchOutbox } from "../schema/intents";
import { openAttempt, storeApprovedIntent, TEST_OTHER_SCALE, TEST_PAYLOAD_DIGEST } from "../test-support/intent-fixtures";
import { openLedgerTestDb, TEST_SCALE } from "../test-support/journal-fixtures";
import {
  abandonDispatch,
  loadDispatch,
  loadExecutionAttempts,
  loadPendingDispatches,
  markDispatched,
  openExecutionAttempt,
  recordAttemptOutcome,
} from "./execution-store";
import { recordApprovedIntent } from "./intent-store";
import { postgresConstraintName, postgresErrorCode, PG_FOREIGN_KEY_VIOLATION, PG_RAISE_EXCEPTION } from "./pg-errors";

// The defects this file kills:
//   * a dispatch that happens with no durable record written first, so a
//     crash between deciding and sending leaves nothing to reconcile;
//   * a retry treated as a fresh authorization to spend rather than a
//     versioned attempt on the same one;
//   * an attempt resubmitted while an earlier one is still live — or, worse,
//     still UNKNOWN, which is the case that can spend the money twice;
//   * an UNKNOWN attempt resolved by assumption instead of by reconciliation;
//   * an intent consumed twice;
//   * a fenced writer still able to mark a dispatch it no longer owns, or
//     told it succeeded while the live leader is told the work is done;
//   * a retry carrying a different payload reported as already enqueued,
//     when the enqueued digest is immutable and that payload can therefore
//     never be dispatched;
//   * a venue clock a few milliseconds behind ours discarding a confirmed
//     fill;
//   * a FILLED attempt reporting no amounts, which settles out of the live
//     index without entering the consumed one and leaves the authorization
//     open to a second attempt;
//   * an on-chain authorization acquiring an exchange lifecycle that cannot
//     describe a broadcast;
//   * a caller cutting the correlation thread between an intent and the
//     attempt that consumes it;
//   * a later event reassigning the venue order an attempt is associated
//     with.
//
// The real-infrastructure fact these claims need is a transaction and the
// migrated schema: every one of them is about what survives a commit, or
// what the database refuses outright.

const { db, close, reset } = openLedgerTestDb("vigil-execution-test");

afterAll(close);
beforeEach(async () => {
  await reset();
  const intent = await recordApprovedIntent(db, storeApprovedIntent("intent-1"));
  expect(intent.outcome).toBe("recorded");
});

async function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

async function countAttempts(): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`select count(*)::text as count from ${executionAttempts}`);
  return Number(rows.rows[0]?.count ?? "-1");
}

/** Drive attempt 1 to a confirmed fill: the intent is now consumed. */
async function fillAttemptOne(): Promise<void> {
  const opened = await openExecutionAttempt(db, openAttempt("intent-1", 1));
  expect(opened.outcome).toBe("opened");

  const filled = await recordAttemptOutcome(db, {
    intentId: "intent-1",
    attempt: 1,
    state: "FILLED",
    spentBase: 900_000n,
    receivedBase: 480_000_000n,
    venueOrderId: "venue-order-1",
    stateChangedAt: "2026-01-02T03:15:00.000Z",
    recordedAt: "2026-01-02T03:15:00.100Z",
    reconciliation: null,
  });
  expect(filled).toMatchObject({ outcome: "recorded", state: "FILLED" });
}

describe("openExecutionAttempt", () => {
  it("writes the attempt and its pending outbox row in one transaction — catches a dispatch represented as attempted with no durable record behind it, which is the crash docs/resilience.md §9 exists to survive", async () => {
    const opened = await openExecutionAttempt(db, openAttempt("intent-1", 1));

    expect(opened).toEqual({ outcome: "opened", attemptId: "att-intent-1-1", dispatchId: "disp-intent-1-1" });

    const attempts = await loadExecutionAttempts(db, "intent-1");
    expect(attempts.map((attempt) => [attempt.attempt, attempt.state, attempt.spentBase])).toEqual([
      [1, "SUBMITTING", 0n],
    ]);

    const dispatch = await loadDispatch(db, "intent-1", 1);
    expect(dispatch).toMatchObject({ state: "pending", dispatchedAt: null, payloadDigest: TEST_PAYLOAD_DIGEST });
  });

  it("denominates the attempt at the intent's own scales rather than at anything the caller supplies — catches a fill recorded in a scale the authorization never named, where the number is right and the amount is wrong by a factor of a hundred", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect([attempt?.inputScale, attempt?.outputScale]).toEqual([TEST_SCALE, TEST_OTHER_SCALE]);
  });

  it("refuses an attempt denominated at a scale the intent did not authorize, even from a writer that never came through this store — catches an attempt row whose scales disagree with its authorization, where every recorded amount is then wrong by a power of ten", async () => {
    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${executionAttempts}
          (attempt_id, intent_id, attempt, client_order_id, correlation_id, input_asset_scale, output_asset_scale, submitted_at, state_changed_at, recorded_at)
        values ('att-wrong-scale', 'intent-1', 1, 'coid-wrong-scale', 'corr-intent-1', ${TEST_SCALE + 1}, ${TEST_OTHER_SCALE},
          '2026-01-02T03:10:00Z', '2026-01-02T03:10:00Z', '2026-01-02T03:10:00.1Z')
      `),
    );

    expect(postgresConstraintName(failure)).toBe("execution_attempts_scales_match_intent");
    expect(await countAttempts()).toBe(0);
  });

  it("reports the same attempt number delivered twice as a duplicate rather than writing a second row — catches a redelivered dispatch instruction becoming a second submission of one attempt", async () => {
    const first = await openExecutionAttempt(db, openAttempt("intent-1", 1));
    const again = await openExecutionAttempt(db, openAttempt("intent-1", 1));

    // The two answers are deliberately NOT identical, and asserting that
    // they were is how this test previously failed against a store doing the
    // right thing. The rows are the same rows — the redelivery is told which
    // ones won — and the outcome is what says the second call opened nothing.
    expect(first).toEqual({ outcome: "opened", attemptId: "att-intent-1-1", dispatchId: "disp-intent-1-1" });
    expect(again).toEqual({ outcome: "duplicate", attemptId: "att-intent-1-1", dispatchId: "disp-intent-1-1" });
    expect(await countAttempts()).toBe(1);
  });

  it("refuses an attempt on an intent nobody authorized and writes nothing — catches an execution path that can act before the authorization is durable", async () => {
    const refused = await openExecutionAttempt(db, openAttempt("intent-never-approved", 1));

    expect(refused).toMatchObject({ outcome: "refused", code: "UNKNOWN_INTENT" });
    expect(await countAttempts()).toBe(0);
  });

  it("refuses an attempt opened after the authorization expired — catches a retry that consumes an authorization whose window has closed", async () => {
    const refused = await openExecutionAttempt(
      db,
      openAttempt("intent-1", 1, { submittedAt: "2026-01-02T05:00:00.000Z", recordedAt: "2026-01-02T05:00:00.100Z" }),
    );

    expect(refused).toMatchObject({ outcome: "refused", code: "INTENT_EXPIRED" });
    expect(await countAttempts()).toBe(0);
  });

  it("refuses a payload digest that is not SHA-256 hex — catches an outbox column holding a payload, a URL, or a credential where a digest belongs", async () => {
    const attempt = openAttempt("intent-1", 1);
    const refused = await openExecutionAttempt(db, {
      ...attempt,
      dispatch: { ...attempt.dispatch, payloadDigest: "not-a-digest" },
    });

    expect(refused).toMatchObject({ outcome: "refused", code: "INVALID_PAYLOAD_DIGEST" });
    expect(await countAttempts()).toBe(0);
  });
});

  it("records a venue event stamped before the local instant the attempt was opened at — catches a cross-clock comparison discarding a confirmed fill because the exchange's clock runs a few milliseconds behind ours, leaving the attempt at SUBMITTING while the venue has the money", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const skewed = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "ACKNOWLEDGED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      // 250ms before `submittedAt`, which is this application's clock.
      stateChangedAt: "2026-01-02T03:09:59.750Z",
      recordedAt: "2026-01-02T03:10:01.000Z",
      reconciliation: null,
    });

    expect(skewed).toMatchObject({ outcome: "recorded", state: "ACKNOWLEDGED" });
    expect((await loadExecutionAttempts(db, "intent-1"))[0]?.state).toBe("ACKNOWLEDGED");
  });

  it("refuses a retry of the same attempt carrying a different payload rather than calling it a duplicate — catches a caller told its dispatch is enqueued when the immutable digest on that row belongs to a payload it does not hold", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    const request = openAttempt("intent-1", 1);

    const changed = await openExecutionAttempt(db, {
      ...request,
      dispatch: { ...request.dispatch, payloadDigest: "ab".repeat(32) },
    });
    const renamed = await openExecutionAttempt(db, { ...request, clientOrderId: "coid-different" });

    expect(changed).toMatchObject({ outcome: "refused", code: "PAYLOAD_MISMATCH" });
    expect(renamed).toMatchObject({ outcome: "refused", code: "PAYLOAD_MISMATCH" });
    expect(await countAttempts()).toBe(1);
  });

  it("threads the attempt and its dispatch under the intent's own correlation id — catches a caller cutting the thread docs/resilience.md §10 needs to tie an authorization to the attempt that consumed it", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    const dispatch = await loadDispatch(db, "intent-1", 1);

    // `corr-intent-1` is the fixture intent's correlation. There is no
    // request field that could have supplied it, which is the point.
    expect(attempt?.correlationId).toBe("corr-intent-1");
    expect(dispatch?.correlationId).toBe("corr-intent-1");
  });

  it("refuses an attempt written directly under a correlation the intent is not threaded under — catches a reconciliation that can find the authorization and not the attempt that consumed it", async () => {
    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${executionAttempts}
          (attempt_id, intent_id, attempt, client_order_id, correlation_id, input_asset_scale, output_asset_scale, submitted_at, state_changed_at, recorded_at)
        values ('att-mis-thread', 'intent-1', 1, 'coid-mis-thread', 'corr-typo', ${TEST_SCALE}, ${TEST_OTHER_SCALE},
          '2026-01-02T03:10:00Z', '2026-01-02T03:10:00Z', '2026-01-02T03:10:00.1Z')
      `),
    );

    expect(postgresConstraintName(failure)).toBe("execution_attempts_correlation_matches_intent");
    expect(await countAttempts()).toBe(0);
  });

  it("refuses to open an exchange attempt on an intent that routes over a chain, and writes nothing — catches a broadcast recorded as ACKNOWLEDGED and a reorganization as a cancellation, the collapse into one abstraction docs/architecture.md rejects", async () => {
    const approved = await recordApprovedIntent(
      db,
      storeApprovedIntent("intent-chain", {
        idempotencyKey: "idem-intent-chain",
        correlationId: "corr-intent-chain",
        economicActionId: "econ-intent-chain",
        chainId: "1337",
        chainValidation: { simulationId: "sim-1", passed: true },
      }),
    );
    expect(approved.outcome).toBe("recorded");

    const refused = await openExecutionAttempt(db, openAttempt("intent-chain", 1));

    expect(refused).toMatchObject({ outcome: "refused", code: "CHAIN_LIFECYCLE_UNSUPPORTED" });
    expect(await loadExecutionAttempts(db, "intent-chain")).toEqual([]);
    expect(await loadDispatch(db, "intent-chain", 1)).toBeNull();
  });

describe("a retry is a versioned attempt, never a second authorization", () => {
  it("refuses a second attempt while the first is still live — catches the defect (intent_id, attempt) uniqueness alone leaves open: nothing in it requires the previous attempt to be finished", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const second = await openExecutionAttempt(db, openAttempt("intent-1", 2));

    expect(second).toMatchObject({ outcome: "refused", code: "INTENT_ALREADY_LIVE" });
    expect(await countAttempts()).toBe(1);
  });

  it("refuses a second attempt while the first is UNKNOWN — this is reconciliation-precedes-resubmission as an index rather than a convention, and the case that can otherwise spend the money twice", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    const unknown = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "UNKNOWN",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:12:00.000Z",
      recordedAt: "2026-01-02T03:12:00.100Z",
      reconciliation: null,
    });
    expect(unknown).toMatchObject({ outcome: "recorded", state: "UNKNOWN" });

    const second = await openExecutionAttempt(db, openAttempt("intent-1", 2));

    expect(second).toMatchObject({ outcome: "refused", code: "INTENT_ALREADY_LIVE" });
    expect(await countAttempts()).toBe(1);
  });

  it("allows the next attempt once the first settles without consuming anything — catches a live-attempt index so broad that a rejected order strands the intent forever", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "REJECTED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:12:00.000Z",
      recordedAt: "2026-01-02T03:12:00.100Z",
      reconciliation: null,
    });

    const second = await openExecutionAttempt(db, openAttempt("intent-1", 2));

    expect(second).toMatchObject({ outcome: "opened", attemptId: "att-intent-1-2" });
  });

  it("refuses two rows claiming the same (intent_id, attempt) even from a writer that never came through this store — catches an attempt number that names two authorizations to act", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${executionAttempts}
          (attempt_id, intent_id, attempt, client_order_id, correlation_id, input_asset_scale, output_asset_scale, submitted_at, state_changed_at, recorded_at)
        values ('att-clash', 'intent-1', 1, 'coid-clash', 'corr-intent-1', ${TEST_SCALE}, ${TEST_OTHER_SCALE},
          '2026-01-02T03:11:00Z', '2026-01-02T03:11:00Z', '2026-01-02T03:11:00.1Z')
      `),
    );

    expect(postgresConstraintName(failure)).toBe("execution_attempts_intent_id_attempt_key");
    expect(await countAttempts()).toBe(1);
  });
});

describe("UNKNOWN is a state, and resolves only through reconciliation", () => {
  beforeEach(async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "UNKNOWN",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:12:00.000Z",
      recordedAt: "2026-01-02T03:12:00.100Z",
      reconciliation: null,
    });
  });

  it("stores UNKNOWN as a state of its own, distinct from every terminal one — catches a submission timeout recorded as a failure, an expiry, or nothing at all", async () => {
    const [attempt] = await loadExecutionAttempts(db, "intent-1");

    expect(attempt?.state).toBe("UNKNOWN");
    expect(attempt?.reconciliation).toBeNull();
  });

  it("refuses a plain state change out of UNKNOWN — catches an application that assumes a timed-out submission failed, or succeeded, instead of asking the venue", async () => {
    const assumed = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "FILLED",
      spentBase: 900_000n,
      receivedBase: 480_000_000n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:13:00.000Z",
      recordedAt: "2026-01-02T03:13:00.100Z",
      reconciliation: null,
    });

    expect(assumed).toMatchObject({ outcome: "refused", code: "UNRECONCILED_UNKNOWN" });
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect([attempt?.state, attempt?.spentBase]).toEqual(["UNKNOWN", 0n]);
  });

  it("resolves UNKNOWN when the write carries the reconciliation it came from — catches a guard so strict that a reconciled attempt can never leave UNKNOWN at all", async () => {
    const resolved = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "ACKNOWLEDGED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:14:00.000Z",
      recordedAt: "2026-01-02T03:14:00.100Z",
      reconciliation: { reconciliationId: "recon-1", reconciledAt: "2026-01-02T03:14:00.000Z" },
    });

    expect(resolved).toMatchObject({ outcome: "recorded", state: "ACKNOWLEDGED" });
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect(attempt?.reconciliation).toEqual({ reconciliationId: "recon-1", reconciledAt: "2026-01-02T03:14:00.000Z" });
  });

  it("resolves UNKNOWN on a reconciliation with a new id at the very same instant — catches a rule keyed on the reconciliation's timestamp, where a millisecond-precision column strands an attempt in UNKNOWN because two genuine reconciliations landed in the same millisecond", async () => {
    const reconciledAt = "2026-01-02T03:14:00.000Z";
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "ACKNOWLEDGED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: reconciledAt,
      recordedAt: "2026-01-02T03:14:00.100Z",
      reconciliation: { reconciliationId: "recon-1", reconciledAt },
    });
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "UNKNOWN",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:15:00.000Z",
      recordedAt: "2026-01-02T03:15:00.100Z",
      reconciliation: null,
    });

    const resolved = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "CANCELED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:16:00.000Z",
      recordedAt: "2026-01-02T03:16:00.100Z",
      // A different reconciliation, at the instant the first one carried.
      reconciliation: { reconciliationId: "recon-2", reconciledAt },
    });

    expect(resolved).toMatchObject({ outcome: "recorded", state: "CANCELED" });
    expect((await loadExecutionAttempts(db, "intent-1"))[0]?.reconciliation).toEqual({
      reconciliationId: "recon-2",
      reconciledAt,
    });
  });

  it("demands a new reconciliation the second time an attempt goes UNKNOWN — catches an attempt leaving UNKNOWN on the strength of the reconciliation that settled it an hour earlier", async () => {
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "ACKNOWLEDGED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:14:00.000Z",
      recordedAt: "2026-01-02T03:14:00.100Z",
      reconciliation: { reconciliationId: "recon-1", reconciledAt: "2026-01-02T03:14:00.000Z" },
    });
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "UNKNOWN",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:16:00.000Z",
      recordedAt: "2026-01-02T03:16:00.100Z",
      reconciliation: null,
    });

    const stale = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "CANCELED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: null,
      stateChangedAt: "2026-01-02T03:17:00.000Z",
      recordedAt: "2026-01-02T03:17:00.100Z",
      // The same reconciliation, re-sent with a later clock reading. A rule
      // keyed on the instant would accept this; the identity of a
      // reconciliation is its id.
      reconciliation: { reconciliationId: "recon-1", reconciledAt: "2026-01-02T03:18:00.000Z" },
    });

    expect(stale).toMatchObject({ outcome: "refused", code: "UNRECONCILED_UNKNOWN" });
  });
});

describe("an approved intent is consumable exactly once", () => {
  // The trigger is disabled for the length of this one case on purpose. It
  // would refuse the insert first, which would leave the partial unique
  // index — the thing that actually holds if a trigger is ever dropped,
  // disabled by a migration, or bypassed — asserted by nothing.
  it("refuses a second spending attempt even with the opening guard disabled — catches a consumed-once rule that lives only in a trigger, where disabling one trigger re-opens the door to spending an authorization twice", async () => {
    await fillAttemptOne();

    let failure: unknown = null;
    await db.execute(sql`alter table ${executionAttempts} disable trigger execution_attempts_opened`);
    try {
      failure = await errorFrom(() =>
        db.execute(sql`
          insert into ${executionAttempts}
            (attempt_id, intent_id, attempt, client_order_id, correlation_id, state, spent_base, received_base,
             input_asset_scale, output_asset_scale, submitted_at, state_changed_at, recorded_at)
          values ('att-second-spend', 'intent-1', 2, 'coid-second-spend', 'corr-intent-1', 'FILLED', 1, 1,
            ${TEST_SCALE}, ${TEST_OTHER_SCALE}, '2026-01-02T03:20:00Z', '2026-01-02T03:20:00Z', '2026-01-02T03:20:00.1Z')
        `),
      );
    } finally {
      await db.execute(sql`alter table ${executionAttempts} enable trigger execution_attempts_opened`);
    }

    expect(postgresConstraintName(failure)).toBe("execution_attempts_intent_id_consumed_key");
    expect(await countAttempts()).toBe(1);
  });

  it("refuses a second attempt opened through the store once the first has spent — catches a remainder chased under the same authorization by the ordinary execution path, which the index alone cannot stop before the money moves", async () => {
    await fillAttemptOne();

    const second = await openExecutionAttempt(db, openAttempt("intent-1", 2));

    expect(second).toMatchObject({ outcome: "refused", code: "INTENT_ALREADY_CONSUMED" });
    expect(await countAttempts()).toBe(1);
  });

  it("refuses any further write to a settled attempt — catches a reconciliation that edits a confirmed fill instead of being recorded as the disagreement it is", async () => {
    await fillAttemptOne();

    const rewrite = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "CANCELED",
      spentBase: 900_000n,
      receivedBase: 480_000_000n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:30:00.000Z",
      recordedAt: "2026-01-02T03:30:00.100Z",
      reconciliation: { reconciliationId: "recon-late", reconciledAt: "2026-01-02T03:30:00.000Z" },
    });

    expect(rewrite).toMatchObject({ outcome: "refused", code: "ATTEMPT_SETTLED" });
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect(attempt?.state).toBe("FILLED");
  });

  it("refuses a write that un-confirms money already recorded — catches a partial fill erased by a later poll that saw less than the one before it", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "PARTIALLY_FILLED",
      spentBase: 400_000n,
      receivedBase: 200_000_000n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:13:00.000Z",
      recordedAt: "2026-01-02T03:13:00.100Z",
      reconciliation: null,
    });

    const shrunk = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "PARTIALLY_FILLED",
      spentBase: 100_000n,
      receivedBase: 50_000_000n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:14:00.000Z",
      recordedAt: "2026-01-02T03:14:00.100Z",
      reconciliation: null,
    });

    expect(shrunk).toMatchObject({ outcome: "refused", code: "OUTCOME_NOT_MONOTONIC" });
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect(attempt?.spentBase).toBe(400_000n);
  });

  it("refuses a FILLED outcome that confirms no amounts, and leaves the attempt live so the intent still cannot be retried — catches the gap between the two indexes: FILLED leaves the live index, a zero spend never enters the consumed one, and the authorization falls through", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const unquantified = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "FILLED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:15:00.000Z",
      recordedAt: "2026-01-02T03:15:00.100Z",
      reconciliation: null,
    });

    expect(unquantified).toMatchObject({ outcome: "refused", code: "FILL_WITHOUT_AMOUNTS" });

    // Fails closed: the attempt is still live, so the intent is still not
    // available for a second attempt while its fate is unresolved.
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect(attempt?.state).toBe("SUBMITTING");
    expect(await openExecutionAttempt(db, openAttempt("intent-1", 2))).toMatchObject({
      outcome: "refused",
      code: "INTENT_ALREADY_LIVE",
    });
  });

  it("refuses a zero-amount FILLED written directly, where no store check is involved — the lifecycle trigger is what holds when the writer is an adapter integration or a repair script", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const failure = await errorFrom(() =>
      db.execute(
        sql`update ${executionAttempts} set state = 'FILLED', state_changed_at = '2026-01-02T03:15:00Z' where intent_id = 'intent-1'`,
      ),
    );

    expect(postgresConstraintName(failure)).toBe("execution_attempts_fill_confirms_amounts");
    expect((await loadExecutionAttempts(db, "intent-1"))[0]?.state).toBe("SUBMITTING");
  });

  it("still settles a CANCELED attempt that confirmed no amounts — catches a rule so broad that an order canceled before it ever filled can never be recorded, which would strand every unfilled attempt", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const canceled = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "CANCELED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-1",
      stateChangedAt: "2026-01-02T03:15:00.000Z",
      recordedAt: "2026-01-02T03:15:00.100Z",
      reconciliation: null,
    });

    expect(canceled).toMatchObject({ outcome: "recorded", state: "CANCELED" });
    // Nothing was spent, so the authorization genuinely is available again.
    expect(await openExecutionAttempt(db, openAttempt("intent-1", 2))).toMatchObject({ outcome: "opened" });
  });

  it("keeps the venue order an attempt was first associated with — catches a later out-of-order or misassociated event pointing every subsequent reconciliation at a different order", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "ACKNOWLEDGED",
      spentBase: 0n,
      receivedBase: 0n,
      venueOrderId: "venue-order-A",
      stateChangedAt: "2026-01-02T03:12:00.000Z",
      recordedAt: "2026-01-02T03:12:00.100Z",
      reconciliation: null,
    });

    const reassigned = await recordAttemptOutcome(db, {
      intentId: "intent-1",
      attempt: 1,
      state: "PARTIALLY_FILLED",
      spentBase: 400_000n,
      receivedBase: 200_000_000n,
      venueOrderId: "venue-order-B",
      stateChangedAt: "2026-01-02T03:13:00.000Z",
      recordedAt: "2026-01-02T03:13:00.100Z",
      reconciliation: null,
    });

    expect(reassigned).toMatchObject({ outcome: "refused", code: "VENUE_ORDER_REASSIGNED" });
    const [attempt] = await loadExecutionAttempts(db, "intent-1");
    expect([attempt?.venueOrderId, attempt?.state]).toEqual(["venue-order-A", "ACKNOWLEDGED"]);
  });

  it("refuses a direct write that renames an attempt — catches the one identifier the immutability guard compared around and not itself, which nothing else references and so would have been renamed silently", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const failure = await errorFrom(() =>
      db.execute(sql`update ${executionAttempts} set attempt_id = 'att-renamed' where intent_id = 'intent-1'`),
    );

    expect(postgresConstraintName(failure)).toBe("execution_attempts_identity_immutable");
    expect((await loadExecutionAttempts(db, "intent-1"))[0]?.attemptId).toBe("att-intent-1-1");
  });

  it("refuses a DELETE against an attempt — catches an intent freed for reuse by removing the record of what was already spent against it", async () => {
    await fillAttemptOne();

    const failure = await errorFrom(() =>
      db.execute(sql`delete from ${executionAttempts} where intent_id = 'intent-1'`),
    );

    expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);
    expect(await countAttempts()).toBe(1);
  });
});

describe("the dispatch outbox", () => {
  it("refuses a dispatch row inserted already dispatched — catches a dispatch recorded after the fact, which is the durable-record-first guarantee written down as though it had been kept", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${intentDispatchOutbox}
          (dispatch_id, intent_id, attempt, correlation_id, state, payload_digest, dispatcher_instance_id,
           fencing_token, enqueued_at, recorded_at, dispatched_at)
        values ('disp-after-the-fact', 'intent-1', 1, 'corr-intent-1', 'dispatched', ${TEST_PAYLOAD_DIGEST},
          'trading-instance-a', 1, '2026-01-02T03:10:00Z', '2026-01-02T03:10:00.1Z', '2026-01-02T03:10:01Z')
      `),
    );

    expect(postgresConstraintName(failure)).toBe("intent_dispatch_outbox_enqueued_pending");
  });

  it("refuses a dispatch row for an attempt that is not in durable history — catches a dispatch with no versioned attempt behind it, and so with no authorization behind that", async () => {
    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${intentDispatchOutbox}
          (dispatch_id, intent_id, attempt, correlation_id, payload_digest, dispatcher_instance_id,
           fencing_token, enqueued_at, recorded_at)
        values ('disp-orphan', 'intent-1', 9, 'corr-intent-1', ${TEST_PAYLOAD_DIGEST},
          'trading-instance-a', 1, '2026-01-02T03:10:00Z', '2026-01-02T03:10:00.1Z')
      `),
    );

    expect(postgresErrorCode(failure)).toBe(PG_FOREIGN_KEY_VIOLATION);
  });

  it("leaves a pending row behind for a dispatch that never completed — catches a restart with nothing to tell it a submission may already have gone out", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const pending = await loadPendingDispatches(db);

    expect(pending.map((dispatch) => [dispatch.dispatchId, dispatch.state])).toEqual([["disp-intent-1-1", "pending"]]);
  });

  it("marks a dispatch as gone and drops it out of the pending sweep — catches a dispatcher that re-sends every payload it ever sent on the next restart", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const marked = await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 1n,
      dispatchedAt: "2026-01-02T03:10:02.000Z",
      recordedAt: "2026-01-02T03:10:02.100Z",
    });

    expect(marked).toEqual({ outcome: "recorded", dispatchId: "disp-intent-1-1" });
    expect(await loadPendingDispatches(db)).toEqual([]);
    expect((await loadDispatch(db, "intent-1", 1))?.dispatchedAt).toBe("2026-01-02T03:10:02.000Z");
  });

  it("reports a repeated mark as a duplicate rather than a refusal — catches a redelivered completion looking like a failure to the writer that already did the work", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    const request = {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 1n,
      dispatchedAt: "2026-01-02T03:10:02.000Z",
      recordedAt: "2026-01-02T03:10:02.100Z",
    };

    await markDispatched(db, request);
    const again = await markDispatched(db, request);

    expect(again).toEqual({ outcome: "duplicate", dispatchId: "disp-intent-1-1" });
  });

  it("refuses a writer carrying a fencing token below the one holding the row, and leaves the dispatch pending — catches a failed-over process still able to record a dispatch it no longer has the authority to make", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1, { dispatch: { ...openAttempt("intent-1", 1).dispatch, fencingToken: 7n } }));

    const fenced = await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-stale",
      fencingToken: 6n,
      dispatchedAt: "2026-01-02T03:10:02.000Z",
      recordedAt: "2026-01-02T03:10:02.100Z",
    });

    expect(fenced).toMatchObject({ outcome: "refused", code: "WRITER_FENCED" });
    expect((await loadDispatch(db, "intent-1", 1))?.state).toBe("pending");
  });

  it("refuses a fenced writer before deciding the work was already done, so the live leader is not handed a success it never made — catches an ordering where the stale leader settles first and the incoming one is told the dispatch is complete", async () => {
    const request = openAttempt("intent-1", 1);
    await openExecutionAttempt(db, { ...request, dispatch: { ...request.dispatch, fencingToken: 9n } });

    const stale = await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-fenced",
      fencingToken: 7n,
      dispatchedAt: "2026-01-02T03:10:02.000Z",
      recordedAt: "2026-01-02T03:10:02.100Z",
    });

    expect(stale).toMatchObject({ outcome: "refused", code: "WRITER_FENCED" });

    const live = await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-b",
      fencingToken: 11n,
      dispatchedAt: "2026-01-02T03:10:03.000Z",
      recordedAt: "2026-01-02T03:10:03.100Z",
    });

    expect(live).toEqual({ outcome: "recorded", dispatchId: "disp-intent-1-1" });
    expect(await loadDispatch(db, "intent-1", 1)).toMatchObject({
      dispatcherInstanceId: "trading-instance-b",
      fencingToken: 11n,
    });
  });

  it("refuses a fenced writer even when the row already carries the state it is asking for — catches the duplicate short-circuit answering before the token is compared, which hands a fenced process a success", async () => {
    const request = openAttempt("intent-1", 1);
    await openExecutionAttempt(db, { ...request, dispatch: { ...request.dispatch, fencingToken: 9n } });
    await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-b",
      fencingToken: 11n,
      dispatchedAt: "2026-01-02T03:10:03.000Z",
      recordedAt: "2026-01-02T03:10:03.100Z",
    });

    const stale = await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-fenced",
      fencingToken: 7n,
      dispatchedAt: "2026-01-02T03:10:04.000Z",
      recordedAt: "2026-01-02T03:10:04.100Z",
    });

    expect(stale).toMatchObject({ outcome: "refused", code: "WRITER_FENCED" });
  });

  it("refuses any further write once a dispatch is settled — catches a second hand-off of one attempt's payload", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));
    await markDispatched(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 1n,
      dispatchedAt: "2026-01-02T03:10:02.000Z",
      recordedAt: "2026-01-02T03:10:02.100Z",
    });

    const abandoned = await abandonDispatch(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 2n,
      reasonCode: "TRANSACTION_UNRESOLVED",
      recordedAt: "2026-01-02T03:11:00.000Z",
    });

    expect(abandoned).toMatchObject({ outcome: "refused", code: "DISPATCH_SETTLED" });
  });

  it("records an abandonment with the reason code that decided it, and refuses one that is not in the registry — catches a dispatch dropped with no recorded reason, which docs/resilience.md §4 does not allow for any refusal", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const invented = await abandonDispatch(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 2n,
      reasonCode: "FELT_WRONG",
      recordedAt: "2026-01-02T03:11:00.000Z",
    });
    const abandoned = await abandonDispatch(db, {
      intentId: "intent-1",
      attempt: 1,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 2n,
      reasonCode: "RESEARCH_EXPIRED",
      recordedAt: "2026-01-02T03:11:00.000Z",
    });

    expect(invented).toMatchObject({ outcome: "refused", code: "INVALID_REASON_CODE" });
    expect(abandoned).toEqual({ outcome: "recorded", dispatchId: "disp-intent-1-1" });
    expect(await loadDispatch(db, "intent-1", 1)).toMatchObject({
      state: "abandoned",
      abandonmentReasonCode: "RESEARCH_EXPIRED",
      dispatchedAt: null,
    });
  });

  it("refuses a rewritten payload digest — catches a committed dispatch record that no longer describes what was actually sent", async () => {
    await openExecutionAttempt(db, openAttempt("intent-1", 1));

    const failure = await errorFrom(() =>
      db.execute(
        sql`update ${intentDispatchOutbox} set payload_digest = ${"ab".repeat(32)} where dispatch_id = 'disp-intent-1-1'`,
      ),
    );

    expect(postgresConstraintName(failure)).toBe("intent_dispatch_outbox_payload_immutable");
    expect((await loadDispatch(db, "intent-1", 1))?.payloadDigest).toBe(TEST_PAYLOAD_DIGEST);
  });
});
