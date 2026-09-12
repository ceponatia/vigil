import { ageMs } from "@vigil/contracts";
import type { IsoUtcTimestamp, ReasonCode } from "@vigil/contracts";

import { quoteSnapshotSchema } from "./quote-snapshot";
import type { QuoteSnapshot } from "./quote-snapshot";

/**
 * freshness.ts — the staleness/corruption gate for a quote snapshot
 * (docs/resilience.md §1 "Fail closed on financial authority", §4
 * "Diagnostics and reason codes over exceptions", §5 "Validate at trust
 * boundaries with zod"; docs/testing.md "Quote/book is stale or corrupt").
 *
 * A stale or corrupt snapshot must never throw on a schema-legal path and
 * must never silently look executable. Both failure modes are folded into
 * one non-executable diagnostic result carrying `STALE_QUOTE`:
 * docs/testing.md's matrix names exactly one required result
 * ("New risk blocked; recover/reload valid state") for the single row that
 * covers both "stale" and "corrupt", and docs/policy.md's reason-code
 * registry defines no separate code for schema corruption — so this
 * function does not invent one. The result shape below is what a
 * downstream policy check (BOOT-06, not built here) consumes.
 */
export type QuoteEvaluation =
  | { readonly executable: true; readonly quote: QuoteSnapshot; readonly ageMs: number }
  | { readonly executable: false; readonly reasonCode: ReasonCode; readonly detail: string };

export type EvaluateQuoteFreshnessParams = {
  /** Untrusted input — parsed against `quoteSnapshotSchema` before use. */
  readonly raw: unknown;
  /**
   * Injected current time; this function reads no clock of its own. Typed
   * as the branded `IsoUtcTimestamp`, but that brand is a compile-time
   * guarantee only — a caller can still bypass it with a cast (`"..." as
   * unknown as IsoUtcTimestamp`), so this function treats an unparseable
   * `now` as corrupt input rather than trusting the type.
   */
  readonly now: IsoUtcTimestamp;
  /**
   * The configured freshness threshold, in milliseconds. Must be a finite,
   * non-negative number — an infinite, negative, or NaN threshold is
   * treated as corrupt configuration, never as "everything passes" or
   * "everything is stale". The boundary is a strict inequality: a quote
   * whose age is exactly `maxAgeMs` is still executable; only an age
   * strictly greater than `maxAgeMs` is stale.
   */
  readonly maxAgeMs: number;
};

/**
 * Parses `raw` as a `QuoteSnapshot` and evaluates its freshness against
 * `now` and `maxAgeMs`, in the `parseOr` shape docs/resilience.md §5
 * describes: parse, and on failure fall back to a safe, explicitly-marked
 * default rather than throwing into the pipeline. Never throws on any
 * input, schema-legal or not.
 *
 * Beyond simple staleness, this also fails closed on inconsistent
 * provenance (docs/evaluation.md "Point-in-time integrity"): an
 * `ingestedAt` before its own `quoteAcquiredAt`, or after `now`, is
 * corrupt data regardless of what the age comparison alone would say.
 */
export function evaluateQuoteFreshness(params: EvaluateQuoteFreshnessParams): QuoteEvaluation {
  const parsed = quoteSnapshotSchema.safeParse(params.raw);
  if (!parsed.success) {
    // Names the offending field(s) — e.g. "bidQuantity" for a non-positive
    // top-of-book size, or "instrumentId" for a ticker-only string — so a
    // caller does not have to re-run the schema itself to find out which
    // part of a rejected quote was actually wrong.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")).filter((path) => path.length > 0))];
    const fieldSummary = fields.length > 0 ? ` (${fields.join(", ")})` : "";
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `quote snapshot failed schema validation${fieldSummary} and is treated as unusable (docs/testing.md "Quote/book is stale or corrupt")`,
    };
  }

  if (!Number.isFinite(params.maxAgeMs) || params.maxAgeMs < 0) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `configured freshness threshold (${String(params.maxAgeMs)}ms) is not a finite, non-negative number; treated as corrupt configuration`,
    };
  }

  const quote = parsed.data;
  const observedAgeMs = ageMs(quote.timestamps.quoteAcquiredAt, params.now);

  if (Number.isNaN(observedAgeMs)) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: 'quote age could not be computed — "now" or "quoteAcquiredAt" did not resolve to a valid instant',
    };
  }

  if (observedAgeMs < 0) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `quote-acquisition timestamp is ${-observedAgeMs}ms after "now"; a future-dated quote is treated as corrupt input, never as unusually fresh`,
    };
  }

  const ingestionLagMs = ageMs(quote.timestamps.quoteAcquiredAt, quote.timestamps.ingestedAt);
  if (ingestionLagMs < 0) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `ingestedAt precedes quoteAcquiredAt by ${-ingestionLagMs}ms; treated as corrupt provenance (docs/evaluation.md "Point-in-time integrity")`,
    };
  }

  const ingestionAgeMs = ageMs(quote.timestamps.ingestedAt, params.now);
  if (ingestionAgeMs < 0) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `ingestedAt is ${-ingestionAgeMs}ms after "now"; treated as corrupt provenance (docs/evaluation.md "Point-in-time integrity")`,
    };
  }

  if (observedAgeMs > params.maxAgeMs) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `quote is ${observedAgeMs}ms old, exceeding the configured ${params.maxAgeMs}ms freshness threshold`,
    };
  }

  return { executable: true, quote, ageMs: observedAgeMs };
}
