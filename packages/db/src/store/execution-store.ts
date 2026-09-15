import { reasonCodeSchema } from "@vigil/contracts";
import { and, asc, eq, sql } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  approvedIntents,
  executionAttempts,
  executionAttemptStateEnum,
  intentDispatchOutbox,
  type DispatchStateValue,
  type ExecutionAttemptStateValue,
} from "../schema/intents";
import {
  describeIntentDriverRefusal,
  refuseIntentWrite,
  type IntentRefusal,
} from "./intent-store";
import { parseIsoInstant } from "./instants";

/**
 * Consuming an authorization, durably, before anything acts on it.
 *
 * `docs/resilience.md` §9 fixes the order this module exists to make
 * unskippable: the intent is persisted, then the attempt and its outbox row,
 * and only then does anything reach a venue. `openExecutionAttempt` writes
 * the attempt and the outbox row in **one transaction** on purpose — an
 * attempt without a dispatch record is a submission nobody can reconcile
 * after a crash, and there is no moment in between for a process to die in.
 *
 * What this module does not decide:
 *
 * - whether a retry is allowed — the one-live-attempt index answers that,
 *   and it counts `UNKNOWN` as live, so "reconciliation precedes
 *   resubmission" holds for a caller that never read this file;
 * - whether the intent may still be consumed — the guard trigger refuses a
 *   new attempt on an intent some earlier attempt already consumed;
 * - whether an `UNKNOWN` attempt may be resolved — the same trigger demands
 *   a reconciliation recorded in the same write.
 *
 * Its own job is to translate those refusals into reason codes
 * (`docs/resilience.md` §4) and to keep a caller from having to restate what
 * the intent already says: the attempt's asset scales are copied from the
 * authorization rather than accepted as arguments, so there is no argument
 * that could denominate a fill in something the intent never authorized.
 */

export const EXECUTION_ATTEMPT_STATES: Readonly<typeof executionAttemptStateEnum.enumValues> =
  executionAttemptStateEnum.enumValues;

/** Lower-case SHA-256 hex, the only thing `payload_digest` accepts. */
const PAYLOAD_DIGEST = /^[0-9a-f]{64}$/u;

const BLANK = /^\s*$/u;

function blank(value: string): boolean {
  return BLANK.test(value);
}

/**
 * What must be durable before a dispatch may happen: the versioned attempt
 * and the outbox row that records the hand-off.
 *
 * `payloadDigest` is a digest of the payload, never the payload: nothing in
 * this family stores a credential, a key, or signing material.
 */
export type OpenAttemptRequest = {
  readonly attemptId: string;
  readonly intentId: string;
  /** Versioned attempt on that intent; starts at 1. */
  readonly attempt: number;
  /** The id the venue is given for this attempt. */
  readonly clientOrderId: string;
  readonly correlationId: string;
  /** ISO-8601 UTC; when the attempt was opened, before anything was submitted. */
  readonly submittedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  readonly dispatch: {
    readonly dispatchId: string;
    /** Lower-case SHA-256 hex of the payload this dispatch will send. */
    readonly payloadDigest: string;
    /** Which writer is claiming this dispatch. */
    readonly dispatcherInstanceId: string;
    /** Monotonic; a writer carrying a lower token has been fenced. */
    readonly fencingToken: bigint;
    /** ISO-8601 UTC; when the row was enqueued, before any dispatch. */
    readonly enqueuedAt: string;
  };
};

export type OpenAttemptResult =
  | { readonly outcome: "opened"; readonly attemptId: string; readonly dispatchId: string }
  /** This attempt number is already open on this intent; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly attemptId: string; readonly dispatchId: string }
  | IntentRefusal;

/** The confirmed state of one attempt, as the venue reported it. */
export type AttemptOutcome = {
  readonly intentId: string;
  readonly attempt: number;
  readonly state: ExecutionAttemptStateValue;
  /**
   * Confirmed cumulative totals, not deltas: the caller reports what the
   * venue says has been spent and received so far, and the guard trigger
   * refuses a write that lowers either. Deltas would double-count a
   * redelivered fill.
   */
  readonly spentBase: bigint;
  readonly receivedBase: bigint;
  /** What the venue calls this order; null leaves whatever is already recorded. */
  readonly venueOrderId: string | null;
  /** ISO-8601 UTC; when this state was observed at the venue. */
  readonly stateChangedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  /**
   * The reconciliation this outcome came from. Required to leave `UNKNOWN`,
   * and a *new* one each time: an attempt that went unknown twice cannot be
   * resolved by the reconciliation that settled it the first time.
   */
  readonly reconciliation: { readonly reconciliationId: string; readonly reconciledAt: string } | null;
};

export type RecordAttemptOutcomeResult =
  | { readonly outcome: "recorded"; readonly attemptId: string; readonly state: ExecutionAttemptStateValue }
  | IntentRefusal;

export type DispatchClaim = {
  readonly intentId: string;
  readonly attempt: number;
  readonly dispatcherInstanceId: string;
  readonly fencingToken: bigint;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
};

export type MarkDispatchedRequest = DispatchClaim & {
  /** ISO-8601 UTC; when the payload actually left. */
  readonly dispatchedAt: string;
};

export type AbandonDispatchRequest = DispatchClaim & {
  /** A `REASON_CODES` member: giving up on a dispatch is a decision. */
  readonly reasonCode: string;
};

export type DispatchResult =
  | { readonly outcome: "recorded"; readonly dispatchId: string }
  /** Already in this state; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly dispatchId: string }
  | IntentRefusal;

export type StoredExecutionAttempt = {
  readonly attemptId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly clientOrderId: string;
  readonly correlationId: string;
  readonly state: ExecutionAttemptStateValue;
  readonly venueOrderId: string | null;
  readonly inputScale: number;
  readonly outputScale: number;
  readonly spentBase: bigint;
  readonly receivedBase: bigint;
  readonly submittedAt: string;
  readonly stateChangedAt: string;
  readonly recordedAt: string;
  readonly reconciliation: { readonly reconciliationId: string; readonly reconciledAt: string } | null;
};

export type StoredDispatch = {
  readonly dispatchId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly correlationId: string;
  readonly state: DispatchStateValue;
  readonly payloadDigest: string;
  readonly dispatcherInstanceId: string;
  readonly fencingToken: bigint;
  readonly enqueuedAt: string;
  readonly recordedAt: string;
  readonly dispatchedAt: string | null;
  readonly abandonmentReasonCode: string | null;
};

function wholeAttempt(attempt: number): boolean {
  return Number.isSafeInteger(attempt) && attempt >= 1;
}

type StoredOpenAttempt = {
  readonly attemptId: string;
  readonly clientOrderId: string;
  readonly dispatchId: string | null;
  readonly payloadDigest: string | null;
};

async function findAttempt(db: VigilDatabase, intentId: string, attempt: number): Promise<StoredOpenAttempt | null> {
  const rows = await db
    .select({
      attemptId: executionAttempts.attemptId,
      clientOrderId: executionAttempts.clientOrderId,
      dispatchId: intentDispatchOutbox.dispatchId,
      payloadDigest: intentDispatchOutbox.payloadDigest,
    })
    .from(executionAttempts)
    .leftJoin(
      intentDispatchOutbox,
      and(
        eq(intentDispatchOutbox.intentId, executionAttempts.intentId),
        eq(intentDispatchOutbox.attempt, executionAttempts.attempt),
      ),
    )
    .where(and(eq(executionAttempts.intentId, intentId), eq(executionAttempts.attempt, attempt)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether a retry is the same work as what is already stored.
 *
 * Returning `duplicate` for a request that differs from the stored row is
 * the quiet failure this exists to prevent: the caller is told its dispatch
 * is enqueued, the payload digest on that row belongs to a *different*
 * payload, and because the digest is immutable the payload the caller
 * actually holds can never be enqueued at all. A dispatcher that then reads
 * the outbox digest to prove "what I am about to send is what was
 * authorized" — the entire purpose of that column — finds a mismatch with
 * nothing to explain it.
 *
 * `dispatchId` is deliberately not compared: which row won is the store's
 * answer to give, and it is returned to the caller either way. What must
 * match is the work — the attempt, the id the venue will see, and the
 * payload.
 */
function describeAttemptMismatch(stored: StoredOpenAttempt, request: OpenAttemptRequest): string | null {
  if (stored.attemptId !== request.attemptId) {
    return `attempt ${request.attempt} on intent ${request.intentId} is already open as ${stored.attemptId}, not ${request.attemptId}`;
  }
  if (stored.clientOrderId !== request.clientOrderId) {
    return `attempt ${request.attempt} on intent ${request.intentId} is already open under client order id ${stored.clientOrderId}, not ${request.clientOrderId}`;
  }
  if (stored.payloadDigest !== null && stored.payloadDigest !== request.dispatch.payloadDigest) {
    return `attempt ${request.attempt} on intent ${request.intentId} already has a dispatch enqueued for a different payload; the enqueued digest is immutable, so this payload can never be dispatched under this attempt`;
  }
  return null;
}

async function findDispatch(db: VigilDatabase, intentId: string, attempt: number): Promise<StoredDispatch | null> {
  const rows = await db
    .select()
    .from(intentDispatchOutbox)
    .where(and(eq(intentDispatchOutbox.intentId, intentId), eq(intentDispatchOutbox.attempt, attempt)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toStoredDispatch(row);
}

function checkOpenRequest(request: OpenAttemptRequest): IntentRefusal | null {
  const identities: ReadonlyArray<readonly [string, string]> = [
    ["attemptId", request.attemptId],
    ["intentId", request.intentId],
    ["clientOrderId", request.clientOrderId],
    ["correlationId", request.correlationId],
    ["dispatch.dispatchId", request.dispatch.dispatchId],
    ["dispatch.dispatcherInstanceId", request.dispatch.dispatcherInstanceId],
  ];
  for (const [field, value] of identities) {
    if (blank(value)) {
      return refuseIntentWrite("EMPTY_IDENTITY", `the execution attempt's ${field} is blank`);
    }
  }

  if (!wholeAttempt(request.attempt)) {
    return refuseIntentWrite(
      "CONSTRAINT_VIOLATION",
      `attempt ${request.attempt} is not a whole attempt number; attempts start at 1`,
    );
  }

  if (!PAYLOAD_DIGEST.test(request.dispatch.payloadDigest)) {
    return refuseIntentWrite(
      "INVALID_PAYLOAD_DIGEST",
      `dispatch ${request.dispatch.dispatchId} carries a payload digest that is not lower-case SHA-256 hex; a digest that is not one proves nothing about what was sent`,
    );
  }

  if (request.dispatch.fencingToken <= 0n) {
    return refuseIntentWrite(
      "INVALID_FENCING_TOKEN",
      `dispatch ${request.dispatch.dispatchId} carries fencing token ${request.dispatch.fencingToken.toString()}; a token that does not increase fences nobody`,
    );
  }

  for (const value of [request.submittedAt, request.recordedAt, request.dispatch.enqueuedAt]) {
    if (parseIsoInstant(value) === null) {
      return refuseIntentWrite(
        "INVALID_TIMESTAMP",
        `execution attempt ${request.attemptId} carries ${value}, which is not an ISO-8601 UTC instant on a real calendar day`,
      );
    }
  }

  return null;
}

/**
 * Thrown inside the transaction so the whole thing rolls back when the
 * authorization is missing, and translated to `UNKNOWN_INTENT` outside it.
 * The attempt's foreign key would refuse the row anyway; reading the intent
 * first is what lets the scales be copied from it rather than trusted.
 */
class UnknownIntent extends Error {
  public readonly intentId: string;

  public constructor(intentId: string) {
    super(`intent ${intentId} is not in durable history`);
    this.name = "UnknownIntent";
    this.intentId = intentId;
  }
}

/**
 * Open a versioned attempt on an approved intent, and enqueue its dispatch.
 *
 * Both rows, or neither. The attempt's asset scales are read from the
 * authorization inside the same transaction rather than taken from the
 * caller, so an attempt cannot denominate a fill in something the intent
 * did not authorize — and the guard trigger checks the copy anyway, for a
 * writer that never came through here.
 */
export async function openExecutionAttempt(
  db: VigilDatabase,
  request: OpenAttemptRequest,
): Promise<OpenAttemptResult> {
  const refusal = checkOpenRequest(request);
  if (refusal !== null) {
    return refusal;
  }

  const submittedAt = parseIsoInstant(request.submittedAt);
  const recordedAt = parseIsoInstant(request.recordedAt);
  const enqueuedAt = parseIsoInstant(request.dispatch.enqueuedAt);
  if (submittedAt === null || recordedAt === null || enqueuedAt === null) {
    return refuseIntentWrite("INVALID_TIMESTAMP", `execution attempt ${request.attemptId} carries an unparseable timestamp`);
  }

  const existing = await findAttempt(db, request.intentId, request.attempt);
  if (existing !== null) {
    const mismatch = describeAttemptMismatch(existing, request);
    if (mismatch !== null) {
      return refuseIntentWrite("PAYLOAD_MISMATCH", mismatch);
    }
    if (existing.dispatchId !== null) {
      return { outcome: "duplicate", attemptId: existing.attemptId, dispatchId: existing.dispatchId };
    }
  }

  try {
    await db.transaction(async (tx) => {
      const intentRows = await tx
        .select({
          inputAssetScale: approvedIntents.inputAssetScale,
          outputAssetScale: approvedIntents.outputAssetScale,
        })
        .from(approvedIntents)
        .where(eq(approvedIntents.intentId, request.intentId))
        .limit(1);

      const intent = intentRows[0];
      if (intent === undefined) {
        throw new UnknownIntent(request.intentId);
      }

      await tx.insert(executionAttempts).values({
        attemptId: request.attemptId,
        intentId: request.intentId,
        attempt: request.attempt,
        clientOrderId: request.clientOrderId,
        correlationId: request.correlationId,
        state: "SUBMITTING",
        venueOrderId: null,
        inputAssetScale: intent.inputAssetScale,
        outputAssetScale: intent.outputAssetScale,
        spentBase: 0n,
        receivedBase: 0n,
        submittedAt,
        stateChangedAt: submittedAt,
        recordedAt,
        reconciledAt: null,
        reconciliationId: null,
      });

      await tx.insert(intentDispatchOutbox).values({
        dispatchId: request.dispatch.dispatchId,
        intentId: request.intentId,
        attempt: request.attempt,
        correlationId: request.correlationId,
        state: "pending",
        payloadDigest: request.dispatch.payloadDigest,
        dispatcherInstanceId: request.dispatch.dispatcherInstanceId,
        fencingToken: request.dispatch.fencingToken,
        enqueuedAt,
        recordedAt,
        dispatchedAt: null,
        abandonmentReasonCode: null,
      });
    });
  } catch (error) {
    if (error instanceof UnknownIntent) {
      return refuseIntentWrite("UNKNOWN_INTENT", `intent ${error.intentId} is not in durable history; nothing authorizes this attempt`);
    }

    const driver = describeIntentDriverRefusal(error);
    if (driver === null) {
      throw error;
    }

    // A duplicate here is the same attempt arriving twice concurrently: the
    // lookup above found nothing because the winner had not committed yet.
    // The winner still has to be the same work, or this is a retry carrying
    // a payload that can never be enqueued.
    if (driver.code === "DUPLICATE_RECORD") {
      const duplicate = await findAttempt(db, request.intentId, request.attempt);
      if (duplicate !== null) {
        const mismatch = describeAttemptMismatch(duplicate, request);
        if (mismatch !== null) {
          return refuseIntentWrite("PAYLOAD_MISMATCH", mismatch);
        }
        if (duplicate.dispatchId !== null) {
          return { outcome: "duplicate", attemptId: duplicate.attemptId, dispatchId: duplicate.dispatchId };
        }
      }
    }

    return refuseIntentWrite(driver.code, driver.detail);
  }

  return { outcome: "opened", attemptId: request.attemptId, dispatchId: request.dispatch.dispatchId };
}

/**
 * Record what the venue confirmed about one attempt.
 *
 * Which transitions are legal is the database's answer, not this function's:
 * a settled attempt takes no further writes, an `UNKNOWN` one resolves only
 * with a fresh reconciliation, and confirmed money never decreases. This
 * function validates shape, writes, and turns whichever rule fired into a
 * reason code.
 */
export async function recordAttemptOutcome(
  db: VigilDatabase,
  outcome: AttemptOutcome,
): Promise<RecordAttemptOutcomeResult> {
  if (!wholeAttempt(outcome.attempt)) {
    return refuseIntentWrite("CONSTRAINT_VIOLATION", `attempt ${outcome.attempt} is not a whole attempt number`);
  }

  if (!EXECUTION_ATTEMPT_STATES.includes(outcome.state)) {
    return refuseIntentWrite("INVALID_STATE", `${outcome.state} is not an execution attempt state`);
  }

  if (outcome.spentBase < 0n || outcome.receivedBase < 0n) {
    return refuseIntentWrite(
      "CONSTRAINT_VIOLATION",
      `attempt ${outcome.attempt} on intent ${outcome.intentId} reports a negative confirmed amount`,
    );
  }

  if (outcome.receivedBase > 0n && outcome.spentBase === 0n) {
    return refuseIntentWrite(
      "CONSTRAINT_VIOLATION",
      `attempt ${outcome.attempt} on intent ${outcome.intentId} reports receiving ${outcome.receivedBase.toString()} base units for nothing`,
    );
  }

  const stateChangedAt = parseIsoInstant(outcome.stateChangedAt);
  const recordedAt = parseIsoInstant(outcome.recordedAt);
  const reconciledAt = outcome.reconciliation === null ? null : parseIsoInstant(outcome.reconciliation.reconciledAt);
  if (stateChangedAt === null || recordedAt === null || (outcome.reconciliation !== null && reconciledAt === null)) {
    return refuseIntentWrite(
      "INVALID_TIMESTAMP",
      `attempt ${outcome.attempt} on intent ${outcome.intentId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }

  if (outcome.reconciliation !== null && blank(outcome.reconciliation.reconciliationId)) {
    return refuseIntentWrite(
      "EMPTY_IDENTITY",
      `attempt ${outcome.attempt} on intent ${outcome.intentId} carries a reconciliation that does not name itself`,
    );
  }

  try {
    const updated = await db
      .update(executionAttempts)
      .set({
        state: outcome.state,
        spentBase: outcome.spentBase,
        receivedBase: outcome.receivedBase,
        // Null leaves whatever the venue already told us: an update that
        // reports no order id is one this application made before the venue
        // acknowledged, not an instruction to forget the id it later did.
        venueOrderId: sql`coalesce(${outcome.venueOrderId}::text, ${executionAttempts.venueOrderId})`,
        stateChangedAt,
        recordedAt,
        // Same rule as `venueOrderId`: an outcome that names no
        // reconciliation leaves the one already on the row. That is what
        // makes the UNKNOWN guard bite — the trigger demands a reconciled_at
        // that DIFFERS from the stored one, so a plain state change cannot
        // borrow the reconciliation that settled an earlier UNKNOWN.
        reconciledAt: sql`coalesce(${reconciledAt}::timestamptz, ${executionAttempts.reconciledAt})`,
        reconciliationId: sql`coalesce(${outcome.reconciliation?.reconciliationId ?? null}::text, ${executionAttempts.reconciliationId})`,
      })
      .where(and(eq(executionAttempts.intentId, outcome.intentId), eq(executionAttempts.attempt, outcome.attempt)))
      .returning({ attemptId: executionAttempts.attemptId });

    const row = updated[0];
    if (row === undefined) {
      return refuseIntentWrite(
        "UNKNOWN_ATTEMPT",
        `attempt ${outcome.attempt} on intent ${outcome.intentId} is not in durable history`,
      );
    }

    return { outcome: "recorded", attemptId: row.attemptId, state: outcome.state };
  } catch (error) {
    const driver = describeIntentDriverRefusal(error);
    if (driver === null) {
      throw error;
    }
    return refuseIntentWrite(driver.code, driver.detail);
  }
}

async function settleDispatch(
  db: VigilDatabase,
  claim: DispatchClaim,
  settled: DispatchStateValue,
  values: { readonly dispatchedAt: Date | null; readonly abandonmentReasonCode: string | null },
): Promise<DispatchResult> {
  const recordedAt = parseIsoInstant(claim.recordedAt);
  if (recordedAt === null) {
    return refuseIntentWrite(
      "INVALID_TIMESTAMP",
      `dispatch for attempt ${claim.attempt} on intent ${claim.intentId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }

  if (claim.fencingToken <= 0n) {
    return refuseIntentWrite("INVALID_FENCING_TOKEN", `fencing token ${claim.fencingToken.toString()} fences nobody`);
  }

  if (blank(claim.dispatcherInstanceId)) {
    return refuseIntentWrite("EMPTY_IDENTITY", "the dispatch does not name the writer claiming it");
  }

  const current = await findDispatch(db, claim.intentId, claim.attempt);
  if (current === null) {
    return refuseIntentWrite(
      "UNKNOWN_DISPATCH",
      `no dispatch is enqueued for attempt ${claim.attempt} on intent ${claim.intentId}`,
    );
  }
  // Fencing is checked BEFORE the duplicate short-circuit, and the order is
  // the whole point. A fenced leader that still holds a stale token would
  // otherwise settle the row first — the trigger refuses only a strictly
  // lower token, and the enqueuing writer's token equals the row's — and
  // the live leader arriving afterwards would be handed a success-shaped
  // `duplicate` for work it never did. Refusing the stale writer here means
  // the answer a fenced process gets is that it has been fenced.
  if (claim.fencingToken < current.fencingToken) {
    return refuseIntentWrite(
      "WRITER_FENCED",
      `dispatch ${current.dispatchId} is held at fencing token ${current.fencingToken.toString()}; this writer carries ${claim.fencingToken.toString()} and has been fenced`,
    );
  }

  // A redelivery of the settlement this row already carries is not a
  // refusal: the work is done, and the writer needs to know that rather
  // than to see the terminal-state guard as a failure.
  if (current.state === settled) {
    return { outcome: "duplicate", dispatchId: current.dispatchId };
  }

  try {
    const updated = await db
      .update(intentDispatchOutbox)
      .set({
        state: settled,
        dispatcherInstanceId: claim.dispatcherInstanceId,
        fencingToken: claim.fencingToken,
        recordedAt,
        dispatchedAt: values.dispatchedAt,
        abandonmentReasonCode: values.abandonmentReasonCode,
      })
      .where(
        and(eq(intentDispatchOutbox.intentId, claim.intentId), eq(intentDispatchOutbox.attempt, claim.attempt)),
      )
      .returning({ dispatchId: intentDispatchOutbox.dispatchId });

    const row = updated[0];
    if (row === undefined) {
      return refuseIntentWrite(
        "UNKNOWN_DISPATCH",
        `no dispatch is enqueued for attempt ${claim.attempt} on intent ${claim.intentId}`,
      );
    }
    return { outcome: "recorded", dispatchId: row.dispatchId };
  } catch (error) {
    const driver = describeIntentDriverRefusal(error);
    if (driver === null) {
      throw error;
    }
    return refuseIntentWrite(driver.code, driver.detail);
  }
}

/**
 * Mark a dispatch as having left this application.
 *
 * `dispatched` says the payload went out, not that the venue accepted it —
 * what the venue did is the attempt's state, and the gap between the two is
 * where `UNKNOWN` lives.
 */
export async function markDispatched(db: VigilDatabase, request: MarkDispatchedRequest): Promise<DispatchResult> {
  const dispatchedAt = parseIsoInstant(request.dispatchedAt);
  if (dispatchedAt === null) {
    return refuseIntentWrite(
      "INVALID_TIMESTAMP",
      `dispatch for attempt ${request.attempt} on intent ${request.intentId} left at ${request.dispatchedAt}, which is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }

  return settleDispatch(db, request, "dispatched", { dispatchedAt, abandonmentReasonCode: null });
}

/**
 * Give up on a dispatch that never left — an expired authorization, a
 * refused pre-check, a shutdown before hand-off. A decision, so it carries a
 * reason code (`docs/resilience.md` §4).
 */
export async function abandonDispatch(db: VigilDatabase, request: AbandonDispatchRequest): Promise<DispatchResult> {
  if (!reasonCodeSchema.safeParse(request.reasonCode).success) {
    return refuseIntentWrite(
      "INVALID_REASON_CODE",
      `${request.reasonCode} is not a member of the reason-code registry in docs/policy.md`,
    );
  }

  return settleDispatch(db, request, "abandoned", {
    dispatchedAt: null,
    abandonmentReasonCode: request.reasonCode,
  });
}

function toStoredAttempt(row: typeof executionAttempts.$inferSelect): StoredExecutionAttempt {
  return {
    attemptId: row.attemptId,
    intentId: row.intentId,
    attempt: row.attempt,
    clientOrderId: row.clientOrderId,
    correlationId: row.correlationId,
    state: row.state,
    venueOrderId: row.venueOrderId,
    inputScale: row.inputAssetScale,
    outputScale: row.outputAssetScale,
    spentBase: row.spentBase,
    receivedBase: row.receivedBase,
    submittedAt: row.submittedAt.toISOString(),
    stateChangedAt: row.stateChangedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    reconciliation:
      row.reconciledAt === null || row.reconciliationId === null
        ? null
        : { reconciliationId: row.reconciliationId, reconciledAt: row.reconciledAt.toISOString() },
  };
}

function toStoredDispatch(row: typeof intentDispatchOutbox.$inferSelect): StoredDispatch {
  return {
    dispatchId: row.dispatchId,
    intentId: row.intentId,
    attempt: row.attempt,
    correlationId: row.correlationId,
    state: row.state,
    payloadDigest: row.payloadDigest,
    dispatcherInstanceId: row.dispatcherInstanceId,
    fencingToken: row.fencingToken,
    enqueuedAt: row.enqueuedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    dispatchedAt: row.dispatchedAt === null ? null : row.dispatchedAt.toISOString(),
    abandonmentReasonCode: row.abandonmentReasonCode,
  };
}

/** Every attempt on one intent, in attempt order. */
export async function loadExecutionAttempts(
  db: VigilDatabase,
  intentId: string,
): Promise<readonly StoredExecutionAttempt[]> {
  const rows = await db
    .select()
    .from(executionAttempts)
    .where(eq(executionAttempts.intentId, intentId))
    .orderBy(asc(executionAttempts.attempt));
  return rows.map(toStoredAttempt);
}

/** The dispatch record for one attempt, or null when none was enqueued. */
export async function loadDispatch(
  db: VigilDatabase,
  intentId: string,
  attempt: number,
): Promise<StoredDispatch | null> {
  return findDispatch(db, intentId, attempt);
}

/**
 * Every dispatch still pending, oldest first.
 *
 * This is the read a restart owes `docs/resilience.md` §8: a row here is a
 * dispatch that may or may not have reached the venue, and nothing may be
 * resubmitted for its attempt until the venue's own state says which.
 */
export async function loadPendingDispatches(db: VigilDatabase): Promise<readonly StoredDispatch[]> {
  const rows = await db
    .select()
    .from(intentDispatchOutbox)
    .where(eq(intentDispatchOutbox.state, "pending"))
    .orderBy(asc(intentDispatchOutbox.enqueuedAt), asc(intentDispatchOutbox.dispatchId));
  return rows.map(toStoredDispatch);
}
