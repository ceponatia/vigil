import { ageMs, isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp } from "@vigil/contracts";
import type { CandidateOutcome, StoredCandidate } from "@vigil/db";

/**
 * candidates.ts — the dashboard's entry-validity read for a candidate
 * (docs/architecture.md "Record families", `decisions`). This is a display
 * derivation only: eligibility, sizing, and risk stay owned by
 * `packages/policy`, which apps/control may not import
 * (docs/architecture.md "Layer graph and import rules").
 *
 * Only `@vigil/db`'s TYPES are imported here — `CandidateOutcome` and
 * `StoredCandidate` carry no runtime import, so this module has no runtime
 * dependency on the store functions that produce them (the interface this
 * slice codes against per the BOOT-07 brief, pinned ahead of the concurrent
 * db slice landing).
 */

export const CANDIDATE_VALIDITY_STATES = [
  "ELIGIBLE",
  "WAITING",
  "MISSED",
  "BLOCKED",
  "EXPIRED",
  "UNEVALUATED",
] as const;

export type CandidateValidityState = (typeof CANDIDATE_VALIDITY_STATES)[number];

export type CandidateValidity = {
  readonly state: CandidateValidityState;
  readonly reasonCode: string | null;
  /** Milliseconds remaining until `expiresAt`; negative once expired. */
  readonly expiresInMs: number | null;
  readonly detail: string;
};

function outcomeToState(outcome: CandidateOutcome): CandidateValidityState {
  switch (outcome) {
    case "ENTRY_ELIGIBLE":
      return "ELIGIBLE";
    case "WAIT":
      return "WAITING";
    case "MISSED":
      return "MISSED";
    case "BLOCKED":
      return "BLOCKED";
  }
}

/**
 * Expiry beats a stale evaluation: a candidate past `expiresAt` reads as
 * EXPIRED even if its last recorded evaluation said ELIGIBLE, because that
 * evaluation is no longer current by the time anyone is looking at it.
 * `now` is injected — this function reads no clock of its own — and an
 * unparseable `expiresAt` fails closed to BLOCKED rather than throwing on
 * schema-legal-looking but corrupt input (docs/resilience.md §4, §5).
 */
export function deriveCandidateValidity(candidate: StoredCandidate, now: IsoUtcTimestamp): CandidateValidity {
  const expiresAt = isoUtcTimestampSchema.safeParse(candidate.expiresAt);
  if (!expiresAt.success) {
    return {
      state: "BLOCKED",
      reasonCode: null,
      expiresInMs: null,
      detail: `candidate ${candidate.candidateId} carries an expiry that is not a valid ISO-8601 UTC timestamp; treated as blocked`,
    };
  }

  // `ageMs(now, expiresAt)` is expiresAt − now, so the boundary instant is
  // +0 rather than the −0 a negated `ageMs(expiresAt, now)` would produce.
  const expiresInMs = ageMs(now, expiresAt.data);
  if (expiresInMs <= 0) {
    return {
      state: "EXPIRED",
      reasonCode: candidate.latestEvaluation?.reasonCode ?? null,
      expiresInMs,
      detail: `candidate ${candidate.candidateId} expired at ${candidate.expiresAt}`,
    };
  }

  if (candidate.latestEvaluation === null) {
    return {
      state: "UNEVALUATED",
      reasonCode: null,
      expiresInMs,
      detail: `candidate ${candidate.candidateId} has not been evaluated yet`,
    };
  }

  return {
    state: outcomeToState(candidate.latestEvaluation.outcome),
    reasonCode: candidate.latestEvaluation.reasonCode,
    expiresInMs,
    detail: candidate.latestEvaluation.detail,
  };
}
