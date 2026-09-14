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
  readonly quoteAcquiredAt: IsoUtcTimestamp | null;
  readonly outcome: CandidateOutcome;
  readonly reasonCode: ReasonCode | null;
  readonly detail: string;
  readonly executablePrice: DecimalString | null;
};

/**
 * An evaluation event is `(candidate, quote, evaluatedAt)` — not just
 * `(candidate, quote)` — so `evaluatedAt` is always part of the id
 * derivation for an executable quote. Without it, the same quote
 * evaluated on either side of `expiresAt` (ENTRY_ELIGIBLE, then MISSED
 * once expired) would derive the identical `idempotencyKey`, and the
 * db's unique constraint would silently drop the second (blocking)
 * record — a fail-open bug, not a merely-cosmetic id collision.
 *
 * The `BLOCKED` path uses distinct tags ("evaluation-blocked" /
 * "evaluation-blocked-idempotency") over `[candidateId, evaluatedAt]`
 * rather than reusing the executable-quote tags with `now` substituted
 * for `quoteAcquiredAt`: a substitution would let a `BLOCKED` evaluation
 * at instant T collide with a genuine executable-quote evaluation whose
 * `quoteAcquiredAt` happens to equal that same T. Distinct tags make that
 * collision structurally impossible rather than merely unlikely.
 */
function buildEvaluation(candidate: Candidate, evaluatedAt: IsoUtcTimestamp, quoteAcquiredAtForId: IsoUtcTimestamp | null, inputs: EvaluationInputs): EntryEvaluation {
  const idParts =
    quoteAcquiredAtForId === null
      ? { tag: "evaluation-blocked", idempotencyTag: "evaluation-blocked-idempotency", parts: [candidate.candidateId, evaluatedAt] }
      : { tag: "evaluation", idempotencyTag: "evaluation-idempotency", parts: [candidate.candidateId, quoteAcquiredAtForId, evaluatedAt] };

  const evaluation: EntryEvaluationRecord = Object.freeze({
    evaluationId: deriveDeterministicId(idParts.tag, idParts.parts),
    idempotencyKey: deriveDeterministicId(idParts.idempotencyTag, idParts.parts),
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
 * 1. quote not executable, or not for this candidate's instrument →
 *    `BLOCKED`, `STALE_QUOTE`
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
    return buildEvaluation(params.candidate, params.now, null, {
      quoteAcquiredAt: null,
      outcome: "BLOCKED",
      reasonCode: freshness.reasonCode,
      detail: freshness.detail,
      executablePrice: null,
    });
  }

  const quote = freshness.quote;
  const { candidate } = params;

  // A schema-legal quote for a DIFFERENT instrument is not evidence about
  // this candidate's price at all — classifying it against this zone
  // would be nonsense regardless of the number. docs/policy.md's registry
  // defines no separate corruption code for "wrong instrument", so this
  // follows packages/market/src/freshness.ts's own precedent (STALE_QUOTE
  // covers both "stale" and "corrupt/unusable"): the quote is simply
  // unusable for this decision.
  if (quote.instrumentId !== candidate.instrumentId) {
    return buildEvaluation(candidate, params.now, null, {
      quoteAcquiredAt: null,
      outcome: "BLOCKED",
      reasonCode: "STALE_QUOTE",
      detail: `quote is for instrument "${quote.instrumentId}", not this candidate's instrument "${candidate.instrumentId}"`,
      executablePrice: null,
    });
  }

  const ask = quote.askPrice;
  const { entryZone } = candidate;
  const extendedMax = addDecimal(entryZone.max, candidate.allowedExtension);
  const quoteAcquiredAt = quote.timestamps.quoteAcquiredAt;
  const shared = { quoteAcquiredAt, executablePrice: ask };

  if (ageMs(candidate.expiresAt, params.now) > 0) {
    return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "RESEARCH_EXPIRED",
      detail: `now (${params.now}) is after this candidate's expiry (${candidate.expiresAt}); the original entry zone [${entryZone.min}, ${entryZone.max}] and reason are preserved, not discarded`,
    });
  }

  if (compareDecimal(ask, candidate.invalidationPrice) < 0) {
    return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "THESIS_INVALIDATED",
      detail: `ask ${ask} is below the invalidation price ${candidate.invalidationPrice}`,
    });
  }

  if (compareDecimal(ask, entryZone.min) >= 0 && compareDecimal(ask, entryZone.max) <= 0) {
    return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
      ...shared,
      outcome: "ENTRY_ELIGIBLE",
      reasonCode: null,
      detail: `ask ${ask} is inside the approved entry zone [${entryZone.min}, ${entryZone.max}]`,
    });
  }

  if (compareDecimal(ask, entryZone.max) > 0 && compareDecimal(ask, extendedMax) <= 0) {
    return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
      ...shared,
      outcome: "WAIT",
      reasonCode: "OUTSIDE_ENTRY_ZONE",
      detail: `ask ${ask} is above the zone's max (${entryZone.max}) but within the allowed extension (up to ${extendedMax}); waiting for a pullback, never chasing`,
    });
  }

  if (compareDecimal(ask, extendedMax) > 0) {
    return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
      ...shared,
      outcome: "MISSED",
      reasonCode: "OUTSIDE_ENTRY_ZONE",
      detail: `ask ${ask} is beyond the allowed extension (${extendedMax}); this entry is missed, never rewritten into a new BUY`,
    });
  }

  // The remaining region is `invalidationPrice <= ask < min`.
  return buildEvaluation(candidate, params.now, quoteAcquiredAt, {
    ...shared,
    outcome: "WAIT",
    reasonCode: "OUTSIDE_ENTRY_ZONE",
    detail: `ask ${ask} is below the zone's min (${entryZone.min}) but has not yet reached invalidation (${candidate.invalidationPrice}); waiting to see if it re-enters the zone`,
  });
}
