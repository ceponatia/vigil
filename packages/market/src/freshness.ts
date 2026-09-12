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
  /** Injected current time; this function reads no clock of its own. */
  readonly now: IsoUtcTimestamp;
  /** The configured freshness threshold, in milliseconds. */
  readonly maxAgeMs: number;
};

/**
 * Parses `raw` as a `QuoteSnapshot` and evaluates its freshness against
 * `now` and `maxAgeMs`, in the `parseOr` shape docs/resilience.md §5
 * describes: parse, and on failure fall back to a safe, explicitly-marked
 * default rather than throwing into the pipeline. Never throws on any
 * input, schema-legal or not.
 */
export function evaluateQuoteFreshness(params: EvaluateQuoteFreshnessParams): QuoteEvaluation {
  const parsed = quoteSnapshotSchema.safeParse(params.raw);
  if (!parsed.success) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: 'quote snapshot failed schema validation and is treated as unusable (docs/testing.md "Quote/book is stale or corrupt")',
    };
  }

  const quote = parsed.data;
  const observedAgeMs = ageMs(quote.timestamps.quoteAcquiredAt, params.now);

  if (observedAgeMs < 0) {
    return {
      executable: false,
      reasonCode: "STALE_QUOTE",
      detail: `quote-acquisition timestamp is ${-observedAgeMs}ms after "now"; a future-dated quote is treated as corrupt input, never as unusually fresh`,
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
