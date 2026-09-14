import type { HoldingsStateValue, StoredBalance } from "@vigil/db";

/**
 * holdings.ts — groups the ledger's `holdings` account family balance rows
 * by asset for the dashboard's Holdings section (docs/architecture.md
 * "Record families", `journal`).
 *
 * Every other account family (`contributed-capital`, `realized-pnl`,
 * `fees`, `exchange`) is out of scope here — `costs.ts` owns `fees`, and
 * nothing in this slice reads the rest.
 */

export type HoldingsStateNet = {
  readonly state: HoldingsStateValue;
  readonly netBase: bigint;
};

export type AssetHoldings = {
  readonly assetId: string;
  readonly assetScale: number;
  readonly states: readonly HoldingsStateNet[];
  readonly totalBase: bigint;
};

function compareAssetIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Nets `debitBase − creditBase` per holdings state and sums every state
 * into the asset's total, in `bigint` throughout — never `Number()` or
 * `parseFloat` on a balance (docs/resilience.md).
 */
export function groupHoldings(balances: readonly StoredBalance[]): readonly AssetHoldings[] {
  const byAsset = new Map<string, { assetScale: number; states: Map<HoldingsStateValue, bigint> }>();

  for (const balance of balances) {
    if (balance.accountFamily !== "holdings" || balance.holdingsState === null) {
      continue;
    }
    const state = balance.holdingsState;
    const entry = byAsset.get(balance.assetId) ?? {
      assetScale: balance.assetScale,
      states: new Map<HoldingsStateValue, bigint>(),
    };
    const net = balance.debitBase - balance.creditBase;
    entry.states.set(state, (entry.states.get(state) ?? 0n) + net);
    byAsset.set(balance.assetId, entry);
  }

  return [...byAsset.entries()]
    .map(([assetId, entry]): AssetHoldings => {
      const states = [...entry.states.entries()].map(([state, netBase]) => ({ state, netBase }));
      const totalBase = states.reduce((sum, item) => sum + item.netBase, 0n);
      return { assetId, assetScale: entry.assetScale, states, totalBase };
    })
    .toSorted((left, right) => compareAssetIds(left.assetId, right.assetId));
}
