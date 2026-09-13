import { sql } from "drizzle-orm";

import { candidateEvaluations, candidates, candidateTranches } from "../schema/decisions";
import { heartbeats } from "../schema/ops";
import type { StoreCandidate, StoreCandidateEvaluation } from "../store/decision-store";
import type { StoreHeartbeat } from "../store/heartbeat-store";
import { openLedgerTestDb, TEST_ASSET, TEST_OTHER_ASSET, TEST_PROVENANCE, type LedgerTestDb } from "./journal-fixtures";

/**
 * Record builders and the database handle for the `decisions` and `ops`
 * integration suites. Never imported by production code and never exported
 * from `src/index.ts`.
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

/**
 * The shared handle, extended with the tables this slice adds.
 *
 * It wraps `openLedgerTestDb` rather than opening a second client of its
 * own: one truncate list that grows with the schema is the whole point of
 * that helper, and a drifting second copy is how a suite ends up asserting
 * against another suite's leftover rows. Children first, so the run works
 * with or without `cascade`.
 *
 * `TRUNCATE` does not fire row-level triggers, which is the only reason a
 * suite can reset a `candidates` table the application itself may never
 * delete from (`drizzle/0008_candidate_append_only_guard.sql`).
 */
export function openDecisionTestDb(applicationName: string): LedgerTestDb {
  const ledger = openLedgerTestDb(applicationName);
  return {
    db: ledger.db,
    close: ledger.close,
    reset: async () => {
      await ledger.db.execute(
        sql`truncate table ${candidateEvaluations}, ${candidateTranches}, ${candidates}, ${heartbeats} restart identity cascade`,
      );
      await ledger.reset();
    },
  };
}
