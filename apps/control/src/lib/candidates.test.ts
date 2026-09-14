import { isoUtcTimestampSchema } from "@vigil/contracts";
import { CANDIDATE_OUTCOMES } from "@vigil/db";
import type { CandidateOutcome, StoreCandidateEvaluation, StoredCandidate } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { deriveCandidateValidity } from "./candidates";
import type { CandidateValidityState } from "./candidates";

// The defect this file kills: a dashboard that reports a candidate as
// still entry-eligible after its entry window closed, or that leaves an
// evaluation outcome unmapped once `@vigil/db` grows one — a candidate with
// no validity state at all rather than an explicit one. The outcome cases
// are derived from the CANDIDATE_OUTCOMES registry, not hand-copied, so a
// new outcome fails this suite instead of silently rendering `undefined`.

const NOW = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");

/**
 * One expected state per registry outcome. Written as a `Record` over
 * `CandidateOutcome` on purpose: `tsc` (the `static checks` job) fails on a
 * missing key the moment `@vigil/db` adds an outcome, and the registry-driven
 * cases below fail at runtime for the same reason.
 */
const EXPECTED_STATE: Record<CandidateOutcome, CandidateValidityState> = {
  ENTRY_ELIGIBLE: "ELIGIBLE",
  WAIT: "WAITING",
  MISSED: "MISSED",
  BLOCKED: "BLOCKED",
};

function evaluation(outcome: CandidateOutcome, reasonCode: string | null): StoreCandidateEvaluation {
  return {
    evaluationId: "eval-1",
    idempotencyKey: "eval-idem-1",
    candidateId: "candidate-1",
    outcome,
    reasonCode,
    detail: "recorded evaluation detail",
    executablePrice: null,
    quoteAcquiredAt: null,
    evaluatedAt: "2024-06-01T11:59:02.000Z",
    recordedAt: "2024-06-01T11:59:02.000Z",
  };
}

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    candidateId: "candidate-1",
    idempotencyKey: "idem-1",
    correlationId: "corr-1",
    strategyId: "strategy-1",
    // A real instrument id: two canonical asset ids joined by "/"
    // (`packages/db/src/store/decision-store.ts` "Canonical instrument id
    // text: baseAssetId/quoteAssetId").
    instrumentId: "chain:1|contract|0xaaa|mainnet/chain:1|native|ETH|mainnet",
    action: "BUY",
    actionDetail: "BUY",
    horizon: "swing",
    entryZoneMin: "100",
    entryZoneMax: "110",
    allowedExtension: "2",
    invalidationPrice: "90",
    invalidationConditions: ["close below 90"],
    expiresAt: "2024-06-01T13:00:00.000Z",
    benchmarkId: "benchmark-1",
    marketSnapshot: {
      quoteAcquiredAt: "2024-06-01T11:59:00.000Z",
      ingestedAt: "2024-06-01T11:59:01.000Z",
      bidPrice: "104",
      askPrice: "105",
    },
    generatedAt: "2024-06-01T11:00:00.000Z",
    recordedAt: "2024-06-01T11:00:01.000Z",
    provenance: {
      policyVersion: "policy-1",
      strategyVersion: "strategy-1",
      modelVersion: null,
      portfolioSnapshotVersion: null,
      marketSnapshotVersion: null,
    },
    tranches: [{ index: 0, quantity: "1", triggerPrice: null }],
    latestEvaluation: null,
    ...overrides,
  };
}

describe("deriveCandidateValidity", () => {
  it("is driven by a non-empty CANDIDATE_OUTCOMES registry — an emptied registry would generate zero outcome cases and still report green", () => {
    expect(CANDIDATE_OUTCOMES.length).toBeGreaterThan(0);
  });

  it("reads UNEVALUATED when no evaluation has been recorded yet", () => {
    const result = deriveCandidateValidity(candidate(), NOW);
    expect(result.state).toBe("UNEVALUATED");
    expect(result.reasonCode).toBeNull();
    expect(result.expiresInMs).toBeGreaterThan(0);
  });

  it.each(CANDIDATE_OUTCOMES)(
    "maps the %s evaluation outcome to its own validity state and carries the evaluation's reason code through",
    (outcome: CandidateOutcome) => {
      const result = deriveCandidateValidity(
        candidate({ latestEvaluation: evaluation(outcome, "OUTSIDE_ENTRY_ZONE") }),
        NOW,
      );
      expect(result.state).toBe(EXPECTED_STATE[outcome]);
      expect(result.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
      expect(result.detail).toBe("recorded evaluation detail");
    },
  );

  it("reads EXPIRED once past expiresAt even when the latest evaluation said eligible", () => {
    const result = deriveCandidateValidity(
      candidate({ expiresAt: "2024-06-01T11:00:00.000Z", latestEvaluation: evaluation("ENTRY_ELIGIBLE", null) }),
      NOW,
    );
    expect(result.state).toBe("EXPIRED");
    expect(result.expiresInMs).toBeLessThanOrEqual(0);
  });

  it("keeps the last evaluation's reason code on an expired candidate, so the operator still sees why it stalled", () => {
    const result = deriveCandidateValidity(
      candidate({ expiresAt: "2024-06-01T11:00:00.000Z", latestEvaluation: evaluation("BLOCKED", "STALE_QUOTE") }),
      NOW,
    );
    expect(result.state).toBe("EXPIRED");
    expect(result.reasonCode).toBe("STALE_QUOTE");
  });

  it("pins the expiry boundary: expiring exactly now is already EXPIRED, one millisecond later is not", () => {
    const atExpiry = deriveCandidateValidity(candidate({ expiresAt: "2024-06-01T12:00:00.000Z" }), NOW);
    expect(atExpiry.state).toBe("EXPIRED");
    expect(atExpiry.expiresInMs).toBe(0);

    const oneMsLater = deriveCandidateValidity(candidate({ expiresAt: "2024-06-01T12:00:00.001Z" }), NOW);
    expect(oneMsLater.state).toBe("UNEVALUATED");
    expect(oneMsLater.expiresInMs).toBe(1);
  });

  it("fails closed to BLOCKED on a corrupt expiresAt rather than throwing", () => {
    const result = deriveCandidateValidity(candidate({ expiresAt: "not-a-timestamp" }), NOW);
    expect(result.state).toBe("BLOCKED");
    expect(result.expiresInMs).toBeNull();
    expect(result.reasonCode).toBeNull();
  });
});
