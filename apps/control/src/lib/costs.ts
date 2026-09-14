import type { StoredBalance } from "@vigil/db";

/**
 * costs.ts — the `fees` account family's totals per asset for the
 * dashboard's Costs section (docs/architecture.md "Record families",
 * `journal`). What this portfolio has paid, not what it holds —
 * `holdings.ts` owns the `holdings` family.
 */

export type AssetCost = {
  readonly assetId: string;
  readonly assetScale: number;
  readonly totalBase: bigint;
};

function compareAssetIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * `debitBase − creditBase` per asset, mirroring `holdings.ts`'s net so a
 * correction (a fee reversal, posted as a credit) nets out the same way an
 * ordinary fee debit does — never `Number()` or `parseFloat` on an amount.
 */
export function summarizeCosts(balances: readonly StoredBalance[]): readonly AssetCost[] {
  const byAsset = new Map<string, { assetScale: number; totalBase: bigint }>();

  for (const balance of balances) {
    if (balance.accountFamily !== "fees") {
      continue;
    }
    const entry = byAsset.get(balance.assetId) ?? { assetScale: balance.assetScale, totalBase: 0n };
    byAsset.set(balance.assetId, {
      assetScale: entry.assetScale,
      totalBase: entry.totalBase + (balance.debitBase - balance.creditBase),
    });
  }

  return [...byAsset.entries()]
    .map(([assetId, entry]): AssetCost => ({ assetId, assetScale: entry.assetScale, totalBase: entry.totalBase }))
    .toSorted((left, right) => compareAssetIds(left.assetId, right.assetId));
}
