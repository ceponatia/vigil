import type { IsoUtcTimestamp } from "@vigil/contracts";

/**
 * Time arithmetic over timestamps `@vigil/contracts` has already validated.
 *
 * The format, the UTC-only rule, the calendar check, and the
 * at-most-milliseconds precision cap all live in
 * `packages/contracts/src/timestamps.ts`, which is where every consumer of a
 * `timestamptz(3)` column shares them. This module used to restate them; it
 * no longer does, so the ledger's `IsoUtcTimestamp` is the same type
 * `@vigil/market` and `packages/db` hold, not a second one that happens to
 * look alike.
 *
 * What a ledger record carries is still this package's business:
 * `occurredAt` for the economic event, `recordedAt` for the write, and
 * `expiresAt` on a reservation — the stage-appropriate subset of the
 * timestamp family in `docs/evaluation.md` "Point-in-time integrity".
 * Keeping event time and record time apart is what lets a replay see only
 * what was knowable at the simulated decision time.
 *
 * This package never reads a clock (`docs/architecture.md`: `ledger` is
 * pure). Time is always an input, so a replay can drive the same arithmetic
 * at any point on the timeline and get the same answer.
 */

/** Epoch milliseconds for an already-validated timestamp. Pure; no clock. */
export function instantMs(timestamp: IsoUtcTimestamp): number {
  return Date.parse(timestamp);
}

/** True when `earlier` is strictly before `later`. */
export function isStrictlyBefore(earlier: IsoUtcTimestamp, later: IsoUtcTimestamp): boolean {
  return instantMs(earlier) < instantMs(later);
}
