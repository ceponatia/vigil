import { decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";

import { parsePolicyConfig } from "../config";
import type { NetEdgeCosts } from "../costs";
import type { PolicyConfig } from "../config";

/**
 * Shared synthetic inputs for this package's suites.
 *
 * Every number below is a **test value chosen to make a boundary legible**,
 * not an owner limit and not a default. `docs/policy.md`'s numerical table
 * is explicitly unapproved discussion defaults, and nothing in
 * `packages/policy`'s source supplies a limit at all — these exist only so
 * a test can state a threshold and then sit exactly on it.
 */

/** Parse helpers, so a suite states a literal once rather than re-parsing inline. */
export const dec = (value: string): DecimalString => decimalStringSchema.parse(value);
export const ts = (value: string): IsoUtcTimestamp => isoUtcTimestampSchema.parse(value);

export const RAW_TEST_CONFIG = {
  maxQuoteAgeMs: 5_000,
  maxReconciliationAgeMs: 60_000,
  minimumNetEdgeQuote: "10",
  quantityScale: 2,
  minimumQuantity: "0.5",
  minimumNotionalQuote: "50",
} as const;

/**
 * A valid limit set, optionally with fields replaced. Goes through the real
 * `parsePolicyConfig` rather than a cast, so a suite can never test against
 * a config shape the guard would actually have refused.
 */
export function testConfig(overrides: Readonly<Record<string, unknown>> = {}): PolicyConfig {
  const result = parsePolicyConfig({ ...RAW_TEST_CONFIG, ...overrides });
  if (result.outcome !== "ok") {
    throw new Error(`test fixture config did not parse: ${result.refusal.detail}`);
  }
  return result.config;
}


/**
 * Costs that charge nothing, so a suite can isolate the bound it is testing
 * from the cost-aware capital and adverse-loss arithmetic. With every
 * component zero, `cashPerUnit` collapses to `executablePrice` and
 * `lossPerUnit` to `stopDistanceQuote`.
 */
export const NO_COSTS: NetEdgeCosts = {
  embedded: { spreadCostPerUnitQuote: dec("0") },
  separatelyCharged: {
    proportionalFeeRate: dec("0"),
    slippageAllowancePerUnitQuote: dec("0"),
    fixedCostsQuote: dec("0"),
  },
};

/** `NO_COSTS` with individual components replaced. Groups are merged, not overwritten wholesale. */
export function testCosts(overrides: {
  readonly embedded?: Partial<NetEdgeCosts["embedded"]>;
  readonly separatelyCharged?: Partial<NetEdgeCosts["separatelyCharged"]>;
} = {}): NetEdgeCosts {
  return {
    embedded: { ...NO_COSTS.embedded, ...overrides.embedded },
    separatelyCharged: { ...NO_COSTS.separatelyCharged, ...overrides.separatelyCharged },
  };
}
