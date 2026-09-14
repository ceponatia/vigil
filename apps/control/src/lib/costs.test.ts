import type { StoredBalance } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { summarizeCosts } from "./costs";

// The defect this file kills: a Costs section that reads the wrong side of
// the ledger — a sign error netting `credit − debit`, which would render
// every fee this portfolio paid as a negative cost (and a fee reversal as a
// charge) — or that quietly folds a non-`fees` account family into the
// total. Every amount here stays `bigint`; no case rounds through a float.

const ASSET_A = "chain:1|contract|0xaaa|mainnet";
const ASSET_B = "chain:1|contract|0xbbb|mainnet";

function feeBalance(overrides: Partial<StoredBalance>): StoredBalance {
  return {
    accountKey: "fees/-/asset",
    accountFamily: "fees",
    holdingsState: null,
    assetId: ASSET_A,
    assetScale: 6,
    debitBase: 0n,
    creditBase: 0n,
    ...overrides,
  };
}

describe("summarizeCosts", () => {
  it("totals fee debits for one asset", () => {
    const costs = summarizeCosts([feeBalance({ debitBase: 1_500n })]);
    expect(costs).toStrictEqual([{ assetId: ASSET_A, assetScale: 6, totalBase: 1_500n }]);
  });

  it("nets a fee reversal credit against the original debit", () => {
    const costs = summarizeCosts([
      feeBalance({ debitBase: 1_000n, creditBase: 0n }),
      feeBalance({ debitBase: 0n, creditBase: 1_000n }),
    ]);
    expect(costs[0]?.totalBase).toBe(0n);
  });

  it("keeps two assets separate and orders them by asset id", () => {
    const costs = summarizeCosts([
      feeBalance({ assetId: ASSET_B, debitBase: 7n }),
      feeBalance({ assetId: ASSET_A, debitBase: 3n }),
    ]);
    expect(costs.map((cost) => cost.assetId)).toStrictEqual([ASSET_A, ASSET_B]);
    expect(costs.map((cost) => cost.totalBase)).toStrictEqual([3n, 7n]);
  });

  it("ignores non-fee account families, such as holdings", () => {
    const costs = summarizeCosts([
      { ...feeBalance({}), accountFamily: "holdings", holdingsState: "available", debitBase: 100n },
    ]);
    expect(costs).toStrictEqual([]);
  });

  it("returns an empty list when nothing has cost anything yet", () => {
    expect(summarizeCosts([])).toStrictEqual([]);
  });
});
