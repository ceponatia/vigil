import { z } from "zod";

/**
 * The stage-appropriate timestamps a ledger record carries, from the
 * timestamp family in `docs/evaluation.md` "Point-in-time integrity":
 *
 * - `occurredAt` — when the economic event happened.
 * - `recordedAt` — when this application wrote it down.
 * - `expiresAt`  — when a reservation stops authorizing anything.
 *
 * Keeping event time and record time apart is what lets a replay see only
 * what was knowable at the simulated decision time; one generic `createdAt`
 * would collapse them and let a later write leak into an earlier decision.
 *
 * This package never reads a clock (`docs/architecture.md`: `ledger` is
 * pure). Time is always an input, so a replay can drive the same arithmetic
 * at any point on the timeline and get the same answer.
 *
 * Seam: a parallel slice gives `packages/contracts` the shared `timestamps`
 * module. When it lands, these three fields move there and this module is
 * deleted rather than kept as a second spelling of the same family.
 */
/**
 * At most three fractional digits, because a millisecond is the finest
 * instant this application can store and read back: `packages/db`'s columns
 * are `timestamptz(3)` and `Date.parse` itself keeps only milliseconds.
 * Accepting `…:05.0004Z` would silently record the event four hundred
 * microseconds earlier than it happened, and a replay comparing event times
 * would see a value nobody wrote.
 */
export const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const isoUtcTimestampSchema = z
  .string()
  .regex(ISO_UTC_TIMESTAMP_PATTERN, {
    error:
      "expected an ISO-8601 UTC timestamp with at most millisecond precision, such as 2026-01-02T03:04:05.000Z",
  })
  // A syntactically well-formed timestamp can still name a day that does not
  // exist: `Date.parse("2026-02-30T00:00:00Z")` does not fail, it rolls the
  // date forward to March 2 — so a calendar-day round trip, not a NaN check,
  // is what catches it. Parsing and formatting a supplied ISO-8601 string is
  // pure text work, not a clock read.
  .refine((value) => {
    const parsed = Date.parse(value);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10);
  }, {
    error: "timestamp is well-formed but names a calendar day that does not exist",
  })
  .brand<"IsoUtcTimestamp">();

export type IsoUtcTimestamp = z.infer<typeof isoUtcTimestampSchema>;

/** Epoch milliseconds for an already-validated timestamp. Pure; no clock. */
export function instantMs(timestamp: IsoUtcTimestamp): number {
  return Date.parse(timestamp);
}

/** True when `earlier` is strictly before `later`. */
export function isStrictlyBefore(earlier: IsoUtcTimestamp, later: IsoUtcTimestamp): boolean {
  return instantMs(earlier) < instantMs(later);
}
