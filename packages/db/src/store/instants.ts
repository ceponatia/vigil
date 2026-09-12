import { isoUtcTimestampSchema } from "@vigil/contracts";

/**
 * Parsing an ISO-8601 instant on the way into a `timestamptz(3)` column.
 *
 * The format rules are `@vigil/contracts`': UTC only, a real calendar day,
 * and at most three fractional-second digits — that last one because this
 * column and `Date.parse` both keep milliseconds, so a finer value would be
 * stored as a different instant than the caller supplied, with nothing in
 * the record to say so. This module used to restate those rules with its own
 * regex and a calendar round trip; it now validates through the shared
 * schema, so `packages/db`, `@vigil/ledger` and `@vigil/market` cannot
 * disagree about what a timestamp is.
 *
 * `Date.parse` reads no clock — it is a pure function of its argument.
 */
export function parseIsoInstant(value: string): Date | null {
  if (!isoUtcTimestampSchema.safeParse(value).success) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
