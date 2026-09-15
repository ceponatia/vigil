import { assetIdentitySchema, canonicalAssetId, isoUtcTimestampSchema } from "@vigil/contracts";
import type { AssetId, IsoUtcTimestamp } from "@vigil/contracts";
import { SYNTHETIC_INSTRUMENT_ID } from "@vigil/market";

import { PAPER_ADAPTER_CAPABILITY_VERSION } from "../capability";
import { proposeOrder, reserveOrder, validateOrder } from "../order";
import type { PaperOrder } from "../order";

/**
 * order-fixtures.ts — package-local test support. Not exported from this
 * package's `index.ts`; imported only from this package's own `*.test.ts`
 * files (`.agents/skills/vigil-testing/references/existing-helpers.md`).
 *
 * Every identifier here is obviously synthetic: chain `1337` with
 * `SYNTHETIC_TESTNET` withdrawal networks, the same labels
 * `@vigil/market`'s synthetic feed uses. No fixture in this repository
 * holds a real address, holding, or credential.
 */

function syntheticAssetId(denomination: string): AssetId {
  return canonicalAssetId(
    assetIdentitySchema.parse({
      kind: "native",
      chainId: "1337",
      nativeDenomination: denomination,
      withdrawalNetwork: "SYNTHETIC_TESTNET",
    }),
  );
}

export const TEST_BASE_ASSET_ID = syntheticAssetId("VGLBASE");
export const TEST_QUOTE_ASSET_ID = syntheticAssetId("VGLQUOTE");

export function instant(value: string): IsoUtcTimestamp {
  return isoUtcTimestampSchema.parse(value);
}

/** The four steps of a submission, 100ms apart, so ordering is visible in a history. */
export const AT_PROPOSED = instant("2024-01-01T00:00:00.000Z");
export const AT_VALIDATED = instant("2024-01-01T00:00:00.100Z");
export const AT_RESERVED = instant("2024-01-01T00:00:00.200Z");
export const AT_SUBMITTED = instant("2024-01-01T00:00:00.300Z");

/** `AT_SUBMITTED` plus `offsetMs`, for driving a scheduled execution to its due time. */
export function afterAcceptance(offsetMs: number): IsoUtcTimestamp {
  return instant(new Date(Date.parse(AT_SUBMITTED) + offsetMs).toISOString());
}

/**
 * The exchange every suite here starts from: money to the cent, quantity to
 * four places, a 25bp fee, and no slippage, so a fill's arithmetic can be
 * pinned to an exact literal.
 */
export const TEST_EXCHANGE_CONFIG = {
  seed: 20_260_915,
  moneyScale: 2,
  quantityScale: 4,
  feeBasisPoints: 25,
  slippageBasisPoints: 0,
} as const;

export function rawQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrumentId: SYNTHETIC_INSTRUMENT_ID,
    bidPrice: "250.00",
    askPrice: "250.10",
    bidQuantity: "50.0000",
    askQuantity: "50.0000",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:00:00.000Z",
      ingestedAt: "2024-01-01T00:00:00.250Z",
    },
    ...overrides,
  };
}

export function rawIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: "intent-0001",
    economicActionId: "action-0001",
    positionPlanId: "plan-0001",
    idempotencyKey: "idem-0001",
    correlationId: "corr-0001",
    venueId: "paper-venue",
    action: "BUY",
    inputAssetId: TEST_QUOTE_ASSET_ID,
    outputAssetId: TEST_BASE_ASSET_ID,
    quantity: "2.0000",
    maxSpend: "510.00",
    minAcceptableReceipt: "0",
    // INPUT-asset, like `maxSpend` beside it and unlike `quantity` above
    // (`OrderEnvelope.permittedResidual`). A dollar of the approved spend may
    // come back without the buy counting as unfinished. Deliberately a
    // money-scale value: at this fixture's ask of 250.10 a dollar of quote is
    // worth about 0.0040 of base, so a settlement's unspent capital and its
    // unfilled quantity straddle this number differently — a test that swaps
    // the two readings cannot pass by coincidence.
    permittedResidual: "1.00",
    validUntil: "2024-01-01T00:10:00.000Z",
    requiredFreshnessMs: 60_000,
    adapterCapabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
    policyVersion: "policy-0001",
    strategyVersion: "strategy-0001",
    // Null is the ordinary case for this adapter's fixtures: a deterministic
    // strategy produced them and no LLM was involved.
    modelVersion: null,
    portfolioSnapshotVersion: "portfolio-0001",
    marketSnapshotVersion: "market-0001",
    feeSnapshotVersion: "fee-0001",
    ...overrides,
  };
}

/**
 * The overrides that turn the buy above into a sell.
 *
 * The assets SWAP, and that is not cosmetic: the adapter derives the
 * instrument its quote must price from the order's own pair — `output/input`
 * for a buy, `input/output` for a sell — so an "EXIT" that kept the buy's
 * asset directions would be refused with `QUOTE_INSTRUMENT_MISMATCH` rather
 * than quietly pricing the wrong way round. Both directions derive
 * `SYNTHETIC_INSTRUMENT_ID`, which is what `rawQuote` carries.
 */
export const SELL_INTENT: Record<string, unknown> = {
  action: "EXIT",
  inputAssetId: TEST_BASE_ASSET_ID,
  outputAssetId: TEST_QUOTE_ASSET_ID,
  minAcceptableReceipt: "490.00",
  // `maxSpend` and `permittedResidual` bound the INPUT asset, which for a
  // sell is the base asset being delivered — so they are quantities here, not
  // money, and the buy's "510.00" would be nonsense. `apps/trading` refuses
  // the sell side outright today (`authorize.ts`, `EXIT_PATH_NOT_BUILT`), so
  // this is the fixture stating the contract rather than pinning a shipped
  // path.
  maxSpend: "2.0000",
  permittedResidual: "0.0100",
};

/**
 * Walks an intent to `RESERVED` the way `apps/trading` will: propose,
 * record the policy check, record the reservation. Throws on a refusal,
 * because a refusal here is a broken fixture rather than the behavior under
 * test — and a silent fallback would let an assertion below pass for the
 * wrong reason.
 */
export function reservedOrder(overrides: Record<string, unknown> = {}, attempt = 1): PaperOrder {
  const proposed = proposeOrder({ intent: rawIntent(overrides), at: AT_PROPOSED, attempt });
  if (!proposed.accepted) {
    throw new Error(`test setup failed at propose: ${proposed.refusal.reason.code} — ${proposed.refusal.detail}`);
  }
  const validated = validateOrder(proposed.order, AT_VALIDATED);
  if (!validated.applied) {
    throw new Error(`test setup failed at validate: ${validated.refusal.reason.code} — ${validated.refusal.detail}`);
  }
  const reserved = reserveOrder(validated.order, AT_RESERVED);
  if (!reserved.applied) {
    throw new Error(`test setup failed at reserve: ${reserved.refusal.reason.code} — ${reserved.refusal.detail}`);
  }
  return reserved.order;
}
