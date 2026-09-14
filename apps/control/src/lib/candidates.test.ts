import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { StoredCandidate } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { deriveCandidateValidity } from "./candidates";

const NOW = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");

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
  it("reads UNEVALUATED when no evaluation has been recorded yet", () => {
    const result = deriveCandidateValidity(candidate(), NOW);
    expect(result.state).toBe("UNEVALUATED");
    expect(result.reasonCode).toBeNull();
    expect(result.expiresInMs).toBeGreaterThan(0);
  });

  it("maps ENTRY_ELIGIBLE to ELIGIBLE", () => {
    const result = deriveCandidateValidity(
      candidate({
        latestEvaluation: {
          evaluationId: "eval-1",
          idempotencyKey: "eval-idem-1",
          candidateId: "candidate-1",
          outcome: "ENTRY_ELIGIBLE",
          reasonCode: null,
          detail: "within entry zone",
          executablePrice: "104.5",
          quoteAcquiredAt: "2024-06-01T11:59:00.000Z",
          evaluatedAt: "2024-06-01T11:59:02.000Z",
          recordedAt: "2024-06-01T11:59:02.000Z",
        },
      }),
      NOW,
    );
    expect(result.state).toBe("ELIGIBLE");
  });

  it("maps WAIT, MISSED, and BLOCKED outcomes to their matching validity state", () => {
    const outcomes = ["WAIT", "MISSED", "BLOCKED"] as const;
    const expected = ["WAITING", "MISSED", "BLOCKED"] as const;
    outcomes.forEach((outcome, index) => {
      const result = deriveCandidateValidity(
        candidate({
          latestEvaluation: {
            evaluationId: "eval-1",
            idempotencyKey: "eval-idem-1",
            candidateId: "candidate-1",
            outcome,
            reasonCode: "OUTSIDE_ENTRY_ZONE",
            detail: "outside entry zone",
            executablePrice: null,
            quoteAcquiredAt: null,
            evaluatedAt: "2024-06-01T11:59:02.000Z",
            recordedAt: "2024-06-01T11:59:02.000Z",
          },
        }),
        NOW,
      );
      expect(result.state).toBe(expected[index]);
      expect(result.reasonCode).toBe("OUTSIDE_ENTRY_ZONE");
    });
  });

  it("reads EXPIRED once past expiresAt even when the latest evaluation said eligible", () => {
    const result = deriveCandidateValidity(
      candidate({
        expiresAt: "2024-06-01T11:00:00.000Z",
        latestEvaluation: {
          evaluationId: "eval-1",
          idempotencyKey: "eval-idem-1",
          candidateId: "candidate-1",
          outcome: "ENTRY_ELIGIBLE",
          reasonCode: null,
          detail: "was eligible before it expired",
          executablePrice: "104.5",
          quoteAcquiredAt: "2024-06-01T10:59:00.000Z",
          evaluatedAt: "2024-06-01T10:59:02.000Z",
          recordedAt: "2024-06-01T10:59:02.000Z",
        },
      }),
      NOW,
    );
    expect(result.state).toBe("EXPIRED");
    expect(result.expiresInMs).toBeLessThanOrEqual(0);
  });

  it("fails closed to BLOCKED on a corrupt expiresAt rather than throwing", () => {
    const result = deriveCandidateValidity(candidate({ expiresAt: "not-a-timestamp" }), NOW);
    expect(result.state).toBe("BLOCKED");
    expect(result.expiresInMs).toBeNull();
  });
});
