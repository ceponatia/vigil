import { loadExecutionAttempts, loadPendingDispatches, LIVE_EXECUTION_ATTEMPT_STATES } from "@vigil/db";
import type { ExecutionAttemptStateValue, VigilDatabase } from "@vigil/db";

/**
 * recover.ts — the read a restart owes `docs/resilience.md` §8: "No
 * unattended restart proceeds while an order or transaction is unresolved."
 *
 * A pending outbox row is a dispatch that may or may not have reached the
 * venue. The process that enqueued it is gone, so nothing in memory knows
 * which, and the only honest answer is the venue's own — which is why every
 * row this returns is reported as needing reconciliation rather than as
 * needing a retry. Nothing here resubmits, and nothing here resolves an
 * attempt: resolving one means reading the venue and recording the
 * reconciliation that settled it (`settle.ts`'s `reconcileAttempt`).
 *
 * This is deliberately a read. A restart that decided for itself what to do
 * with an ambiguous dispatch is exactly the blind retry the whole execution
 * path is shaped against, and the decision belongs to an operator or to the
 * driver that owns the retry profile.
 */

export type UnresolvedDispatch = {
  readonly intentId: string;
  readonly attempt: number;
  readonly dispatchId: string;
  readonly correlationId: string;
  /** ISO-8601 UTC; when the row was enqueued, before any dispatch. */
  readonly enqueuedAt: string;
  /**
   * The attempt's own state, or `null` when no attempt row exists for it —
   * which a `NOT NULL` foreign key makes impossible today, and which is
   * reported rather than assumed away if it ever becomes possible.
   */
  readonly attemptState: ExecutionAttemptStateValue | null;
  /** True while the attempt's outcome is not settled, `UNKNOWN` included. */
  readonly attemptLive: boolean;
  readonly clientOrderId: string | null;
  readonly venueOrderId: string | null;
};

/**
 * Every dispatch this application enqueued and has not settled, oldest
 * first, with the state of the attempt behind it.
 *
 * A caller reconciles each one against the venue before dispatching anything
 * new on the same authorization. It does not have to remember to: the
 * one-live-attempt index refuses a second attempt while any of these is
 * live, and the adapter refuses a resubmission under a client order id whose
 * outcome no authoritative read has resolved. This read is what makes the
 * situation *visible* rather than what makes it safe.
 */
export async function loadUnresolvedDispatches(db: VigilDatabase): Promise<readonly UnresolvedDispatch[]> {
  const pending = await loadPendingDispatches(db);
  const unresolved: UnresolvedDispatch[] = [];

  for (const dispatch of pending) {
    const attempts = await loadExecutionAttempts(db, dispatch.intentId);
    const attempt = attempts.find((candidate) => candidate.attempt === dispatch.attempt) ?? null;
    unresolved.push({
      intentId: dispatch.intentId,
      attempt: dispatch.attempt,
      dispatchId: dispatch.dispatchId,
      correlationId: dispatch.correlationId,
      enqueuedAt: dispatch.enqueuedAt,
      attemptState: attempt === null ? null : attempt.state,
      attemptLive: attempt !== null && isLiveAttemptState(attempt.state),
      clientOrderId: attempt === null ? null : attempt.clientOrderId,
      venueOrderId: attempt === null ? null : attempt.venueOrderId,
    });
  }

  return unresolved;
}

/**
 * Whether an attempt's outcome is still open. Derived from `@vigil/db`'s own
 * list rather than restated, so a state added to the lifecycle cannot be
 * quietly treated as settled here.
 */
export function isLiveAttemptState(state: ExecutionAttemptStateValue): boolean {
  return (LIVE_EXECUTION_ATTEMPT_STATES as readonly ExecutionAttemptStateValue[]).includes(state);
}
