import { z } from "zod";

/**
 * timestamps.ts — the point-in-time timestamp family
 * (docs/evaluation.md "Point-in-time integrity"; docs/architecture.md
 * "Contracts"). vigil keeps distinct timestamps across the whole lifecycle
 * of a decision so a historical replay can see exactly what was knowable
 * at the time it claims to represent — nothing pulled from a later stage
 * may leak into an earlier one.
 *
 * Every timestamp is an ISO-8601 UTC string on the wire (never a `Date`
 * object, never epoch milliseconds as a bare number) and is branded so a
 * caller cannot hand an arbitrary string to a function that expects one.
 *
 * This module performs no clock reads: no `Date.now()`, no bare `new
 * Date()`. `ageMs` below is pure age arithmetic over two already-known
 * timestamps — the caller (ultimately something outside `@vigil/contracts`
 * and `@vigil/market`) is responsible for supplying "now".
 */
export const isoUtcTimestampSchema = z.iso.datetime().brand<"IsoUtcTimestamp">();

export type IsoUtcTimestamp = z.infer<typeof isoUtcTimestampSchema>;

/**
 * The eleven named stages of the timestamp family, in lifecycle order
 * (docs/evaluation.md "Point-in-time integrity"):
 *
 * 1. event occurrence      → `eventOccurredAt`
 * 2. publication           → `publishedAt`
 * 3. first observation     → `firstObservedAt`
 * 4. ingestion             → `ingestedAt`
 * 5. feature availability  → `featureAvailableAt`
 * 6. analysis completion   → `analysisCompletedAt`
 * 7. intent creation       → `intentCreatedAt`
 * 8. quote acquisition     → `quoteAcquiredAt`
 * 9. submission/broadcast  → `submittedAt`
 * 10. acknowledgement/inclusion → `acknowledgedAt`
 * 11. fill/finality        → `filledAt`
 */
export const TIMESTAMP_STAGES = [
  "eventOccurredAt",
  "publishedAt",
  "firstObservedAt",
  "ingestedAt",
  "featureAvailableAt",
  "analysisCompletedAt",
  "intentCreatedAt",
  "quoteAcquiredAt",
  "submittedAt",
  "acknowledgedAt",
  "filledAt",
] as const;

export type TimestampStage = (typeof TIMESTAMP_STAGES)[number];

/**
 * The full timestamp family as one record. Every stage is optional here —
 * a given record family fills in only the stages it actually produces
 * (docs/architecture.md "Record families") — but a stage that IS present
 * must be a validated `IsoUtcTimestamp`. Field names are listed out
 * explicitly (rather than built from `TIMESTAMP_STAGES` via a mapped
 * type) so each one keeps its own precise, non-widened type; the
 * registry-derived test in `timestamps.test.ts` keeps this object's keys
 * from drifting out of sync with `TIMESTAMP_STAGES`.
 */
export const timestampFamilySchema = z.object({
  eventOccurredAt: isoUtcTimestampSchema.optional(),
  publishedAt: isoUtcTimestampSchema.optional(),
  firstObservedAt: isoUtcTimestampSchema.optional(),
  ingestedAt: isoUtcTimestampSchema.optional(),
  featureAvailableAt: isoUtcTimestampSchema.optional(),
  analysisCompletedAt: isoUtcTimestampSchema.optional(),
  intentCreatedAt: isoUtcTimestampSchema.optional(),
  quoteAcquiredAt: isoUtcTimestampSchema.optional(),
  submittedAt: isoUtcTimestampSchema.optional(),
  acknowledgedAt: isoUtcTimestampSchema.optional(),
  filledAt: isoUtcTimestampSchema.optional(),
});

export type TimestampFamily = z.infer<typeof timestampFamilySchema>;

/**
 * The stage-appropriate subset of the timestamp family a quote snapshot
 * carries (this issue's settled scope: "at least the quote-acquisition and
 * ingestion stages"). Both are required here, unlike their optional
 * counterparts on `timestampFamilySchema` — a quote snapshot without a
 * quote-acquisition time cannot be aged at all, so `@vigil/market`'s
 * freshness check depends on this being non-optional.
 */
export const quoteTimestampsSchema = z.object({
  quoteAcquiredAt: isoUtcTimestampSchema,
  ingestedAt: isoUtcTimestampSchema,
});

export type QuoteTimestamps = z.infer<typeof quoteTimestampsSchema>;

/**
 * Pure age arithmetic: milliseconds elapsed from `timestamp` to `now`.
 * Positive when `timestamp` precedes `now` (the ordinary case); negative
 * when `timestamp` is after `now` (a future-dated timestamp — callers such
 * as `@vigil/market`'s freshness check treat this as a corruption signal,
 * not as "very fresh").
 *
 * `Date.parse` reads no clock — it is a pure function of the string
 * argument — so this stays inside the "no clock read in
 * `@vigil/contracts`" rule despite using the platform `Date` machinery.
 */
export function ageMs(timestamp: IsoUtcTimestamp, now: IsoUtcTimestamp): number {
  return Date.parse(now) - Date.parse(timestamp);
}
