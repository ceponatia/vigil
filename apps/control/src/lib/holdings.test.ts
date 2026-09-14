import type { StoredBalance } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { groupHoldings } from "./holdings";

// The defect this file kills: a Holdings section built on the wrong net —
// a sign error posting `credit − debit`, a state total that silently drops
// one of an asset's holdings states, or a non-`holdings` account family
// counted as if the portfolio owned it. Every amount stays `bigint`; no
// case rounds through a float (docs/resilience.md, product rule 5).

const ASSET_A = "chain:1|contract|0xaaa|mainnet";
const ASSET_B = "chain:1|contract|0xbbb|mainnet";

function balance(overrides: Partial<StoredBalance>): StoredBalance {
  return {
    accountKey: "holdings/available/asset",
    accountFamily: "holdings",
    holdingsState: "available",
    assetId: ASSET_A,
    assetScale: 6,
    debitBase: 0n,
    creditBase: 0n,
    ...overrides,
  };
}

describe("groupHoldings", () => {
  it("nets debit minus credit per holdings state", () => {
    const groups = groupHoldings([balance({ debitBase: 1_000_000n, creditBase: 400_000n })]);
    expect(groups).toStrictEqual([
      {
        assetId: ASSET_A,
        assetScale: 6,
        states: [{ state: "available", netBase: 600_000n }],
        totalBase: 600_000n,
      },
    ]);
  });

  it("sums every state of one asset into its total", () => {
    const groups = groupHoldings([
      balance({ holdingsState: "available", debitBase: 500_000n, creditBase: 0n }),
      balance({ holdingsState: "reserved", debitBase: 200_000n, creditBase: 0n }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.totalBase).toBe(700_000n);
    expect(groups[0]?.states).toHaveLength(2);
  });

  it("keeps two assets separate and orders them by asset id", () => {
    const groups = groupHoldings([
      balance({ assetId: ASSET_B, debitBase: 1n }),
      balance({ assetId: ASSET_A, debitBase: 2n }),
    ]);
    expect(groups.map((group) => group.assetId)).toStrictEqual([ASSET_A, ASSET_B]);
  });

  it("ignores every non-holdings account family, such as fees", () => {
    const groups = groupHoldings([
      balance({ accountFamily: "fees", holdingsState: null, debitBase: 100n }),
    ]);
    expect(groups).toStrictEqual([]);
  });

  it("returns an empty list for no balances, never a fabricated zero row", () => {
    expect(groupHoldings([])).toStrictEqual([]);
  });
});
