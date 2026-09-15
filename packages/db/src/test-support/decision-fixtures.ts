import type { StoreCandidate, StoreCandidateEvaluation, StorePositionPlan } from "../store/decision-store";
import type { StoreHeartbeat } from "../store/heartbeat-store";
import { TEST_ASSET, TEST_OTHER_ASSET, TEST_PROVENANCE } from "./journal-fixtures";

/**
 * Record builders for the `decisions` and `ops` integration suites. Never
 * imported by production code and never exported from `src/index.ts`.
 *
 * The database handle lives in `journal-fixtures.ts`: `openLedgerTestDb`
 * owns the one truncate list for this package, and these tables were added
 * to it rather than reset by a second list of their own.
 *
 * Identities are the synthetic ones `journal-fixtures.ts` already declares,
 * on chain `1337` — the id this codebase reserves for the synthetic test
 * chain. No address, key, holding, or real instrument appears here, and
 * every price below is obviously invented.
 */

/**
 * `baseAssetId/quoteAssetId`, built from the two synthetic assets rather
 * than typed out: an instrument id that could not itself pass the canonical
 * shape would be testing the store against records the application cannot
 * produce.
 */
export const TEST_INSTRUMENT = `${TEST_OTHER_ASSET}/${TEST_ASSET}`;

export function storeCandidate(candidateId: string, overrides: Partial<StoreCandidate> = {}): StoreCandidate {
  return {
    candidateId,
    idempotencyKey: `idem-${candidateId}`,
    correlationId: `corr-${candidateId}`,
    strategyId: "strategy-numerical-0",
    instrumentId: TEST_INSTRUMENT,
    action: "BUY",
    actionDetail: "SMALL_STARTER",
    horizon: "swing",
    entryZoneMin: "100.00",
    entryZoneMax: "104.00",
    allowedExtension: "0.50",
    invalidationPrice: "92.00",
    invalidationConditions: ["closes below the prior swing low"],
    expiresAt: "2026-01-02T12:00:00.000Z",
    benchmarkId: "benchmark-hold-settlement-reserve",
    marketSnapshot: {
      quoteAcquiredAt: "2026-01-02T03:04:05.000Z",
      ingestedAt: "2026-01-02T03:04:05.500Z",
      bidPrice: "101.50",
      askPrice: "101.75",
    },
    generatedAt: "2026-01-02T03:04:06.000Z",
    recordedAt: "2026-01-02T03:04:06.250Z",
    provenance: TEST_PROVENANCE,
    tranches: [
      { index: 0, quantity: "1.5", triggerPrice: null },
      { index: 1, quantity: "2.5", triggerPrice: "99.00" },
    ],
    ...overrides,
  };
}

/**
 * The durable terms of a staged plan.
 *
 * The entry zone brackets `storeCandidate`'s own, and the exit price sits
 * above both, so a case that swapped the zone for the target — or read one
 * price column into another — produces a plan that no longer describes an
 * entry below a target, rather than one that still looks plausible.
 */
export function storePositionPlan(
  positionPlanId: string,
  overrides: Partial<StorePositionPlan> = {},
): StorePositionPlan {
  return {
    positionPlanId,
    correlationId: `corr-${positionPlanId}`,
    instrumentId: TEST_INSTRUMENT,
    entryZoneMin: "100.00",
    entryZoneMax: "104.00",
    thesisExitPrice: "118.00",
    formationReferenceMid: "101.62",
    formedAt: "2026-01-02T03:04:06.000Z",
    recordedAt: "2026-01-02T03:04:06.250Z",
    provenance: TEST_PROVENANCE,
    ...overrides,
  };
}

export function storeEvaluation(
  evaluationId: string,
  candidateId: string,
  overrides: Partial<StoreCandidateEvaluation> = {},
): StoreCandidateEvaluation {
  return {
    evaluationId,
    idempotencyKey: `idem-${evaluationId}`,
    candidateId,
    outcome: "WAIT",
    reasonCode: "OUTSIDE_ENTRY_ZONE",
    detail: "the executable price sits above the entry zone",
    executablePrice: "105.00",
    quoteAcquiredAt: "2026-01-02T03:10:00.000Z",
    evaluatedAt: "2026-01-02T03:10:01.000Z",
    recordedAt: "2026-01-02T03:10:01.250Z",
    ...overrides,
  };
}

export function storeHeartbeat(overrides: Partial<StoreHeartbeat> = {}): StoreHeartbeat {
  return {
    process: "trading",
    instanceId: "instance-a",
    operatingMode: "PAPER",
    observedAt: "2026-01-02T03:04:05.000Z",
    recordedAt: "2026-01-02T03:04:05.100Z",
    lastQuoteAcquiredAt: "2026-01-02T03:04:04.000Z",
    detail: null,
    ...overrides,
  };
}
