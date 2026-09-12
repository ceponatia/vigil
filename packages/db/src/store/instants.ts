/**
 * Parsing an ISO-8601 instant on the way into a `timestamptz(3)` column.
 *
 * `new Date("2026-02-30T00:00:00Z")` does not fail — it rolls forward to
 * March 2 — so a calendar day that does not exist would be stored as a
 * different, perfectly plausible instant, and the record would say the
 * economic event happened on a day it did not. The round trip below is what
 * catches that.
 *
 * `@vigil/ledger` applies the same guard to its own timestamps. The layer
 * graph forbids this package from importing it, so the rule is stated twice
 * on purpose; both move to `packages/contracts`'s timestamp module when it
 * lands.
 */

/**
 * At most three fractional digits. `timestamptz(3)` stores milliseconds and
 * `Date.parse` keeps milliseconds, so a finer value is truncated on the way
 * in: the record would state an event time up to a millisecond before the
 * one the caller supplied, and no later reader could tell. Refusing is the
 * only honest option, since this layer cannot round a decision's timestamp
 * on the caller's behalf.
 */
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The instant `value` names, or null when it names none. Never a clock read. */
export function parseIsoInstant(value: string): Date | null {
  if (!ISO_UTC_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const instant = new Date(parsed);
  return instant.toISOString().slice(0, 10) === value.slice(0, 10) ? instant : null;
}
