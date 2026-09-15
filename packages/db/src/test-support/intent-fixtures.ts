import type { OpenAttemptRequest } from "../store/execution-store";
import type { StoreApprovedIntent } from "../store/intent-store";
import { TEST_ASSET, TEST_OTHER_ASSET, TEST_SCALE } from "./journal-fixtures";

/**
 * Record builders for the `intents` family's integration suites. Never
 * imported by production code and never exported from `src/index.ts`.
 *
 * The database handle lives in `journal-fixtures.ts`: `openLedgerTestDb`
 * owns the one truncate list for this package, and these tables were added
 * to it rather than reset by a second list of their own.
 *
 * The two sides deliberately use **different scales** — the spent asset at
 * `TEST_SCALE` (6) and the acquired one at `TEST_OTHER_SCALE` (8). A
 * fixture that used one scale for both would let an input/output mix-up
 * pass every assertion in this package.
 *
 * Identities are the synthetic ones `journal-fixtures.ts` declares, on chain
 * `1337`. No address, key, holding, venue credential, or real instrument
 * appears here, and `PAPER` is the only operating mode any of them names.
 */

/** The acquired asset's scale; deliberately not the spent asset's. */
export const TEST_OTHER_SCALE = 8;

/**
 * An obviously synthetic SHA-256-shaped digest. It is not the digest of
 * anything: the column only ever holds a digest, so a fixture needs the
 * shape and nothing else.
 */
export const TEST_PAYLOAD_DIGEST = "5f0e".repeat(16);

export function storeApprovedIntent(intentId: string, overrides: Partial<StoreApprovedIntent> = {}): StoreApprovedIntent {
  return {
    intentId,
    idempotencyKey: `idem-${intentId}`,
    correlationId: `corr-${intentId}`,
    economicActionId: `econ-${intentId}`,
    positionPlanId: `plan-${intentId}`,
    candidateId: null,
    operatingMode: "PAPER",
    fundingAccountId: "account-paper-settlement",
    venueId: "venue-paper",
    chainId: null,
    routeId: null,
    input: {
      assetId: TEST_ASSET,
      scale: TEST_SCALE,
      maxSpendBase: 1_000_000n,
      permittedResidualBase: 1_000n,
    },
    output: {
      assetId: TEST_OTHER_ASSET,
      scale: TEST_OTHER_SCALE,
      quantityBase: 500_000_000n,
      minAcceptableReceiptBase: 480_000_000n,
    },
    validUntil: "2026-01-02T04:00:00.000Z",
    requiredFreshnessMs: 5_000,
    protectionPlan: null,
    remainingInventoryTreatment: "KEEP",
    benchmarkId: "benchmark-hold-settlement-reserve",
    approvalReason: "within the entry zone and inside every exposure limit",
    adapterCapabilityVersion: "adapter-paper-0",
    chainValidation: null,
    approvedAt: "2026-01-02T03:00:00.000Z",
    recordedAt: "2026-01-02T03:00:00.100Z",
    provenance: {
      policyVersion: "policy-test-0",
      strategyVersion: "strategy-test-0",
      modelVersion: null,
      portfolioSnapshotVersion: "portfolio-test-0",
      marketSnapshotVersion: "market-test-0",
      feeSnapshotVersion: "fee-test-0",
    },
    ...overrides,
  };
}

export function openAttempt(
  intentId: string,
  attempt: number,
  overrides: Partial<OpenAttemptRequest> = {},
): OpenAttemptRequest {
  return {
    attemptId: `att-${intentId}-${attempt}`,
    intentId,
    attempt,
    clientOrderId: `coid-${intentId}-${attempt}`,
    correlationId: `corr-${intentId}`,
    submittedAt: "2026-01-02T03:10:00.000Z",
    recordedAt: "2026-01-02T03:10:00.100Z",
    dispatch: {
      dispatchId: `disp-${intentId}-${attempt}`,
      payloadDigest: TEST_PAYLOAD_DIGEST,
      dispatcherInstanceId: "trading-instance-a",
      fencingToken: 1n,
      enqueuedAt: "2026-01-02T03:10:00.050Z",
    },
    ...overrides,
  };
}
