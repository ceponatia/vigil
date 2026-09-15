import { describe, expect, it } from "vitest";

import {
  checkAccountReconciled,
  checkEntryZone,
  checkExposure,
  checkNetEdge,
  checkQuoteFreshness,
} from "./eligibility";
import type { ExposureCap, NetEdgeCosts } from "./eligibility";
import type { DecimalString } from "@vigil/contracts";

import { dec, testConfig, ts } from "./test-support/fixtures";

const config = testConfig();

// ---------------------------------------------------------------------------
// ACCOUNT_UNRECONCILED — docs/resilience.md §1: unreconciled balances block
// new risk. The bug class: treating absence of evidence (never reconciled,
// an uncomputable age) as evidence that everything reconciles.
// ---------------------------------------------------------------------------
describe("checkAccountReconciled", () => {
  const now = ts("2024-01-01T00:01:00.000Z");

  it("is eligible when reconciliation is recent and found nothing outstanding", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: ts("2024-01-01T00:00:30.000Z"), unresolvedDiscrepancyCount: 0 },
      now,
      config,
    });
    expect(result.eligible).toBe(true);
  });

  it("raises ACCOUNT_UNRECONCILED when balances have never been reconciled — 'no reconciliation record' is not 'nothing was wrong'", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: null, unresolvedDiscrepancyCount: 0 },
      now,
      config,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });

  it("raises ACCOUNT_UNRECONCILED on any unresolved discrepancy, however recent the reconciliation", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: ts("2024-01-01T00:00:59.999Z"), unresolvedDiscrepancyCount: 1 },
      now,
      config,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });

  it("is still eligible exactly at maxReconciliationAgeMs — the threshold itself is not yet stale", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: ts("2024-01-01T00:00:00.000Z"), unresolvedDiscrepancyCount: 0 },
      now,
      config,
    });
    expect(result.eligible).toBe(true);
  });

  it("raises ACCOUNT_UNRECONCILED one millisecond past the threshold — a boundary off-by-one would silently widen one configured limit", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: ts("2023-12-31T23:59:59.999Z"), unresolvedDiscrepancyCount: 0 },
      now,
      config,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });

  it("raises ACCOUNT_UNRECONCILED for a future-dated reconciliation rather than reading it as unusually fresh — a skewed or fabricated clock would otherwise unblock new risk indefinitely", () => {
    const result = checkAccountReconciled({
      state: { reconciledThrough: ts("2024-01-01T00:02:00.000Z"), unresolvedDiscrepancyCount: 0 },
      now,
      config,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });
});

// ---------------------------------------------------------------------------
// STALE_QUOTE
// ---------------------------------------------------------------------------
describe("checkQuoteFreshness", () => {
  const quoteAcquiredAt = ts("2024-01-01T00:00:00.000Z");

  it("is eligible well inside the threshold and reports the age it measured", () => {
    const result = checkQuoteFreshness({ quoteAcquiredAt, now: ts("2024-01-01T00:00:02.000Z"), config });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.ageMs).toBe(2_000);
    }
  });

  it("is still eligible exactly at maxQuoteAgeMs, matching packages/market's own strict-inequality boundary", () => {
    const result = checkQuoteFreshness({ quoteAcquiredAt, now: ts("2024-01-01T00:00:05.000Z"), config });
    expect(result.eligible).toBe(true);
  });

  it("raises STALE_QUOTE the instant the quote is older than its threshold", () => {
    const result = checkQuoteFreshness({ quoteAcquiredAt, now: ts("2024-01-01T00:00:05.001Z"), config });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("STALE_QUOTE");
    }
  });

  it("raises STALE_QUOTE for a future-dated quote rather than treating it as fresh", () => {
    const result = checkQuoteFreshness({
      quoteAcquiredAt: ts("2024-01-01T00:00:10.000Z"),
      now: ts("2024-01-01T00:00:00.000Z"),
      config,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("STALE_QUOTE");
    }
  });
});

// ---------------------------------------------------------------------------
// OUTSIDE_ENTRY_ZONE
// ---------------------------------------------------------------------------
describe("checkEntryZone", () => {
  const entryZone = { min: dec("100"), max: dec("110") };

  it("is eligible inside the approved zone", () => {
    expect(checkEntryZone({ executablePrice: dec("105"), entryZone }).eligible).toBe(true);
  });

  it.each(["100", "110"])("is eligible exactly at the zone boundary %s — the approved zone includes its own endpoints", (price) => {
    expect(checkEntryZone({ executablePrice: dec(price), entryZone }).eligible).toBe(true);
  });

  it("raises OUTSIDE_ENTRY_ZONE below the zone", () => {
    const result = checkEntryZone({ executablePrice: dec("99.99"), entryZone });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("OUTSIDE_ENTRY_ZONE");
    }
  });

  it("raises OUTSIDE_ENTRY_ZONE above the zone and never extends it to reach the moved price — admitting a price above the approved zone at the allocator is chasing, through the one component whose 'yes' spends money", () => {
    const result = checkEntryZone({ executablePrice: dec("110.01"), entryZone });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("OUTSIDE_ENTRY_ZONE");
    }
  });

  it("compares numerically, not lexicographically — a price of 9 against a zone of [10, 20] is below it, though the strings would sort the other way", () => {
    const result = checkEntryZone({ executablePrice: dec("9"), entryZone: { min: dec("10"), max: dec("20") } });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("OUTSIDE_ENTRY_ZONE");
    }
  });

  // checkEntryZone had no never-throws coverage at all, which is how the
  // zod 4 refine defect stayed invisible here. entryZoneSchema's refine is
  // object-level, and in zod 4 an object-level refine runs even when one of
  // its own fields failed its string check — so `compareDecimal`, which is
  // arithmetic and throws on an unrecognized shape, was reachable with a
  // value like "1e-3". A throw inside a refine escapes safeParse entirely.
  const shapeInvalid = ["1e-3", "+1", " 1", "1.", ""] as const;

  it.each(shapeInvalid)("refuses a shape-invalid min (%j) as a diagnostic instead of throwing out of the check", (bad) => {
    const params = { executablePrice: dec("105"), entryZone: { min: bad as unknown as DecimalString, max: dec("110") } };
    expect(() => checkEntryZone(params)).not.toThrow();
    const result = checkEntryZone(params);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
    }
  });

  it.each(shapeInvalid)("refuses a shape-invalid max (%j) without throwing", (bad) => {
    const params = { executablePrice: dec("105"), entryZone: { min: dec("100"), max: bad as unknown as DecimalString } };
    expect(() => checkEntryZone(params)).not.toThrow();
    expect(checkEntryZone(params).eligible).toBe(false);
  });

  it.each(shapeInvalid)("refuses a shape-invalid executablePrice (%j) without throwing", (bad) => {
    const params = { executablePrice: bad as unknown as DecimalString, entryZone: { min: dec("100"), max: dec("110") } };
    expect(() => checkEntryZone(params)).not.toThrow();
    expect(checkEntryZone(params).eligible).toBe(false);
  });

  it("refuses an inverted zone as malformed input, not as a policy decision about the price", () => {
    const result = checkEntryZone({ executablePrice: dec("105"), entryZone: { min: dec("110"), max: dec("100") } });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
    }
  });
});

// ---------------------------------------------------------------------------
// EXPOSURE_LIMIT
// ---------------------------------------------------------------------------
describe("checkExposure", () => {
  const assetCap: ExposureCap = {
    scope: "asset",
    label: "SYNTH-A",
    currentExposureQuote: dec("200"),
    capQuote: dec("1000"),
  };
  const portfolioCap: ExposureCap = {
    scope: "portfolio",
    label: "total",
    currentExposureQuote: dec("9500"),
    capQuote: dec("10000"),
  };

  it("reports the smallest headroom across every cap, and which cap produced it", () => {
    const result = checkExposure({ caps: [assetCap, portfolioCap] });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.headroomQuote).toBe("500");
      expect(result.bindingCap.label).toBe("total");
      expect(result.bindingCap.scope).toBe("portfolio");
    }
  });

  it("refuses an empty cap set with NO_EXPOSURE_CAP — folding an empty list into a 'smallest so far' seeded at infinity is how 'no cap applies' silently becomes 'no limit applies'", () => {
    const result = checkExposure({ caps: [] });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NO_EXPOSURE_CAP");
    }
  });

  it("raises EXPOSURE_LIMIT when exposure sits exactly at the cap — the cap bounds RESULTING exposure, so a cap already met leaves nothing to add", () => {
    const result = checkExposure({
      caps: [{ ...assetCap, currentExposureQuote: dec("1000"), capQuote: dec("1000") }],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("EXPOSURE_LIMIT");
    }
  });

  it("raises EXPOSURE_LIMIT when already over the cap", () => {
    const result = checkExposure({
      caps: [{ ...assetCap, currentExposureQuote: dec("1200"), capQuote: dec("1000") }],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("EXPOSURE_LIMIT");
    }
  });

  it("raises EXPOSURE_LIMIT when any one of several caps is exhausted, not only the first", () => {
    const result = checkExposure({
      caps: [assetCap, { ...portfolioCap, currentExposureQuote: dec("10000") }],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("EXPOSURE_LIMIT");
      expect(result.refusal.detail).toContain("total");
    }
  });

  it("refuses a negative exposure or cap as malformed input rather than deriving headroom from it", () => {
    const result = checkExposure({ caps: [{ ...assetCap, currentExposureQuote: dec("-1") }] });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
    }
  });
});

// ---------------------------------------------------------------------------
// INSUFFICIENT_NET_EDGE
// ---------------------------------------------------------------------------
describe("checkNetEdge", () => {
  const costs: NetEdgeCosts = {
    proportionalFeeRate: dec("0.001"),
    spreadCostPerUnitQuote: dec("0.5"),
    slippageAllowancePerUnitQuote: dec("0.2"),
    fixedCostsQuote: dec("2"),
  };
  const base = {
    quantity: dec("10"),
    executablePrice: dec("100"),
    costs,
    config,
  };

  it("subtracts every supplied cost and clears the threshold when enough edge survives", () => {
    const result = checkNetEdge({ ...base, expectedGrossEdgePerUnitQuote: dec("5") });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      // gross 50, costs 1 (fee) + 5 (spread) + 2 (slippage) + 2 (fixed) = 10
      expect(result.breakdown.grossEdgeQuote).toBe("50");
      expect(result.breakdown.totalCostQuote).toBe("10");
      expect(result.breakdown.netEdgeQuote).toBe("40");
    }
  });

  it("clears the threshold when net edge sits exactly on it", () => {
    const result = checkNetEdge({ ...base, expectedGrossEdgePerUnitQuote: dec("2") });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.breakdown.netEdgeQuote).toBe("10");
      expect(result.breakdown.minimumNetEdgeQuote).toBe("10");
    }
  });

  it("raises INSUFFICIENT_NET_EDGE when costs consume the advantage, and still reports the breakdown that explains it", () => {
    const result = checkNetEdge({ ...base, expectedGrossEdgePerUnitQuote: dec("1") });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("policy");
      expect(result.refusal.reason.code).toBe("INSUFFICIENT_NET_EDGE");
      expect(result.breakdown?.netEdgeQuote).toBe("0");
      expect(result.breakdown?.totalCostQuote).toBe("10");
    }
  });

  it("counts the fixed cost even though it does not scale with size — a model with only per-unit costs would make gas vanish as size shrinks", () => {
    // gross 19 at this per-unit edge. Without the fixed 2 the costs are 8,
    // leaving net 11 and clearing the minimum of 10; with it they are 10,
    // leaving net 9 and refusing. The fixed cost is the whole difference.
    const withoutFixed = checkNetEdge({
      ...base,
      expectedGrossEdgePerUnitQuote: dec("1.9"),
      costs: { ...costs, fixedCostsQuote: dec("0") },
    });
    const withFixed = checkNetEdge({ ...base, expectedGrossEdgePerUnitQuote: dec("1.9") });
    expect(withoutFixed.eligible).toBe(true);
    expect(withFixed.eligible).toBe(false);
    if (!withFixed.eligible) {
      expect(withFixed.refusal.reason.code).toBe("INSUFFICIENT_NET_EDGE");
      expect(withFixed.breakdown?.netEdgeQuote).toBe("9");
    }
  });

  it("refuses a negative cost component instead of summing it — a mis-signed rebate would INFLATE net edge past a threshold it does not actually clear", () => {
    const result = checkNetEdge({
      ...base,
      expectedGrossEdgePerUnitQuote: dec("1"),
      costs: { ...costs, fixedCostsQuote: dec("-20") },
    });
    // Summed naively this is gross 10 less costs -12, i.e. net 22, which
    // would clear the minimum of 10 and authorize the trade.
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NEGATIVE_COST_COMPONENT");
      expect(result.refusal.detail).toContain("fixedCostsQuote");
    }
  });

  const negativeCostCases: readonly (readonly [string, NetEdgeCosts])[] = [
    ["proportionalFeeRate", { ...costs, proportionalFeeRate: dec("-1") }],
    ["spreadCostPerUnitQuote", { ...costs, spreadCostPerUnitQuote: dec("-1") }],
    ["slippageAllowancePerUnitQuote", { ...costs, slippageAllowancePerUnitQuote: dec("-1") }],
    ["fixedCostsQuote", { ...costs, fixedCostsQuote: dec("-1") }],
  ];

  it.each(negativeCostCases)("refuses a negative %s, naming the component", (field, negativeCosts) => {
    const result = checkNetEdge({
      ...base,
      expectedGrossEdgePerUnitQuote: dec("5"),
      costs: negativeCosts,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("NEGATIVE_COST_COMPONENT");
      expect(result.refusal.detail).toContain(field);
    }
  });

  it("refuses a non-positive price as input, not as a policy judgement about the proposal", () => {
    const result = checkNetEdge({ ...base, executablePrice: dec("0"), expectedGrossEdgePerUnitQuote: dec("5") });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.code).toBe("NON_POSITIVE_PRICE");
    }
  });

  it("refuses a non-positive quantity — net edge is only meaningful at a real size", () => {
    const result = checkNetEdge({ ...base, quantity: dec("0"), expectedGrossEdgePerUnitQuote: dec("5") });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.refusal.reason.source).toBe("input");
    }
  });
});
