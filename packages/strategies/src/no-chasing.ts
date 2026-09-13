import { ageMs } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp, ReasonCode } from "@vigil/contracts";
import { evaluateQuoteFreshness } from "@vigil/market";

import type { Candidate } from "./candidate";
import { deriveDeterministicId } from "./candidate";
import { addDecimal, compareDecimal } from "./scaled-decimal";

/**
 * no-chasing.ts — the entry-admission check (docs/testing.md "Entry
 * discipline": "Attractive historical low; current executable price
 * outside the approved entry zone" → "WAIT/MISSED; no late chasing
 * trade"; docs/product.md "Action vocabulary": "a candidate classified as
 * a missed entry ... never becomes BUY"). `evaluateEntry` never derives a
 * new entry zone from the current price — it only classifies today's ask
 * against the zone a `Candidate` already carries, and hands that same
 * `Candidate` back untouched.
 */

export const CANDIDATE_OUTCOMES = ["ENTRY_ELIGIBLE", "WAIT", "MISSED", "BLOCKED"] as const;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

export type EntryEvaluationRecord = {
  readonly evaluationId: string;
  readonly idempotencyKey: string;
  readonly candidateId: string;
  readonly outcome: CandidateOutcome;
  /** `null` only for `ENTRY_ELIGIBLE` — eligible is not itself a rejection. */
  readonly reasonCode: ReasonCode | null;
  readonly detail: string;
  /** The ask price this evaluation decided against; `null` only for `BLOCKED`, where no price was executable at all. */
  readonly executablePrice: DecimalString | null;
  /** `null` when the quote failed to parse at all (`BLOCKED`/`STALE_QUOTE`) — there is no validated acquisition time to report. */
  readonly quoteAcquiredAt: IsoUtcTimestamp | null;
  readonly evaluatedAt: IsoUtcTimestamp;
};

/**
 * `candidate` is the exact object passed in — same identity, same
 * `entryZone`, same everything — so a caller can never mistake this for
 * a rewritten proposal. Only `evaluation` is new.
 */
export type EntryEvaluation = {
  readonly candidate: Candidate;
  readonly evaluation: EntryEvaluationRecord;
};

export type EvaluateEntryParams = {
  readonly candidate: Candidate;
  /** Untrusted input — parsed via `evaluateQuoteFreshness` before use. */
  readonly quote: unknown;
  readonly now: IsoUtcTimestamp;
  readonly maxQuoteAgeMs: number;
};

type EvaluationInputs = {
  readonly quoteAcquiredAtForId: IsoUtcTimestamp;
  readonly quoteAcquiredAt: IsoUtcTimestamp | null;
  readonly outcome: CandidateOutcome;
  readonly reasonCode: ReasonCode | null;
  readonly detail: string;
  readonly executablePrice: DecimalString | null;
};

function buildEvaluation(candidate: Candidate, evaluatedAt: IsoUtcTimestamp, inputs: EvaluationInputs): EntryEvaluation {
  // evaluationId/idempotencyKey are deterministic, like candidate.ts's own
  // ids — this package reads no clock and calls no random-id generator, so
  // there is no other source of an id to derive from. When the quote
  // itself never validated (BLOCKED/STALE_QUOTE), its acquisition time
  // cannot be trusted either, so `now` stands in as the id input instead
  // (documented on `quoteAcquiredAtForId`); the reported `quoteAcquiredAt`
  // field stays `null` in that case rather than reporting an unvalidated
  // value as if it were real provenance.
  const idParts = [candidate.candidateId, inputs.quoteAcquiredAtForId];
  const evaluation: EntryEvaluationRecord = Object.freeze({
    evaluationId: deriveDeterministicId("evaluation", idParts),
    idempotencyKey: deriveDeterministicId("evaluation-idempotency", idParts),
    candidateId: candidate.candidateId,
    outcome: inputs.outcome,
    reasonCode: inputs.reasonCode,
    detail: inputs.detail,
    executablePrice: inputs.executablePrice,
    quoteAcquiredAt: inputs.quoteAcquiredAt,
    evaluatedAt,
  });
  return Object.freeze({ candidate, evaluation });
}

/**
 * Classifies `quote`'s current ask against `candidate`'s already-approved
 * entry zone. Decision table, evaluated in this exact order (the first
 * matching row wins):
 *
 * 1. quote not executable → `BLOCKED`, `STALE_QUOTE`
 * 2. `now` after `expiresAt` → `MISSED`, `RESEARCH_EXPIRED`
 * 3. ask below `invalidationPrice` → `MISSED`, `THESIS_INVALIDATED`
 * 4. ask inside `[min, max]` → `ENTRY_ELIGIBLE` (not itself a BUY — sizing
 *    and policy checks are BOOT-06's job)
 * 5. ask above `max` but within `allowedExtension` → `WAIT`, `OUTSIDE_ENTRY_ZONE`
 * 6. ask beyond `max + allowedExtension` → `MISSED`, `OUTSIDE_ENTRY_ZONE`
 * 7. ask below `min` but at or above `invalidationPrice` → `WAIT`, `OUTSIDE_ENTRY_ZONE`
 *
 * No branch of this function ever computes a new entry zone from `ask` —
 * every comparison reads `candidate`'s existing zone, never writes one.
 */
export function evaluateEntry(params: EvaluateEntryParams): EntryEvaluation {
  const freshness = evaluateQuoteFreshness({ raw: params.quote, now: params.now, maxAgeMs: params.maxQuoteAgeMs });

  if (!freshness.executable) {
    return buildEvaluation(params.candidate, params.now, {
      quoteAcquiredAtForId: params.now,
      quoteAcquiredAt: null,
      outcome: "BLOCKED",
      reasonCode: freshness.reasonCode,
      detail: freshness.detail,
      executablePrice: null,
    });
  }

  const quote = freshness.quote;
  const ask = quote.askPrice;
  const { candidate } = params;
  const { entryZone } = candidate;
  const extendedMax = addDecimal(entryZone.max, candidate.allowedExtension);
  const shared = {
    quoteAcquiredAtForId: quote.timestamps.quoteAcquiredAt,
    quoteAcquiredAt: quote.timestamps.quoteAcquiredAt,
    executablePrice: ask,
  };

  if (ageMs(candidate.expiresAt, params.now) > 0) {
    return buildEvaluation(candidate, params.now, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "RESEARCH_EXPIRED",
      detail: `now (${params.now}) is after this candidate's expiry (${candidate.expiresAt}); the original entry zone [${entryZone.min}, ${entryZone.max}] and reason are preserved, not discarded`,
    });
  }

  if (compareDecimal(ask, candidate.invalidationPrice) < 0) {
    return buildEvaluation(candidate, params.now, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "THESIS_INVALIDATED",
      detail: `ask ${ask} is below the invalidation price ${candidate.invalidationPrice}`,
    });
  }

  if (compareDecimal(ask, entryZone.min) >= 0 && compareDecimal(ask, entryZone.max) <= 0) {
    return buildEvaluation(candidate, params.now, {
      ...shared,
      outcome: "ENTRY_ELIGIBLE",
      reasonCode: null,
      detail: `ask ${ask} is inside the approved entry zone [${entryZone.min}, ${entryZone.max}]`,
    });
  }

  if (compareDecimal(ask, entryZone.max) > 0 && compareDecimal(ask, extendedMax) <= 0) {
    return buildEvaluation(candidate, params.now, {
      ...shared,
      outcome: "WAIT",
      reasonCode: "OUTSIDE_ENTRY_ZONE",
      detail: `ask ${ask} is above the zone's max (${entryZone.max}) but within the allowed extension (up to ${extendedMax}); waiting for a pullback, never chasing`,
    });
  }

  if (compareDecimal(ask, extendedMax) > 0) {
    return buildEvaluation(candidate, params.now, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "OUTSIDE_ENTRY_ZONE",
      detail: `ask ${ask} is beyond the allowed extension (${extendedMax}); this entry is missed, never rewritten into a new BUY`,
    });
  }

  // The remaining region is `invalidationPrice <= ask < min`.
  return buildEvaluation(candidate, params.now, {
    ...shared,
    outcome: "WAIT",
    reasonCode: "OUTSIDE_ENTRY_ZONE",
    detail: `ask ${ask} is below the zone's min (${entryZone.min}) but has not yet reached invalidation (${candidate.invalidationPrice}); waiting to see if it re-enters the zone`,
  });
}
