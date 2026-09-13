import type { StoredBalance } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { summarizeCosts } from "./costs";

const ASSET_A = "chain:1|contract|0xaaa|mainnet";

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
