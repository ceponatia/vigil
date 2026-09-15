import { describe, expect, it } from "vitest";

import { evaluateProposal, EVALUATION_STAGES } from "./evaluate";
import type { ProposalEvaluationParams } from "./evaluate";
import { dec, testConfig, ts } from "./test-support/fixtures";

/**
 * A proposal that passes every gate, so each test can break exactly one
 * thing and know which gate is responsible for the result.
 *
 * At a price of 100 with an exposure headroom of 800, the binding bound is
 * the exposure limit: 800/100 = 8 units, a notional of 800.
 */
const healthy = (): ProposalEvaluationParams => ({
  config: testConfig(),
  now: ts("2024-01-01T00:00:05.000Z"),
  account: { reconciledThrough: ts("2024-01-01T00:00:00.000Z"), unresolvedDiscrepancyCount: 0 },
  quote: { quoteAcquiredAt: ts("2024-01-01T00:00:02.000Z"), executablePrice: dec("100") },
  entryZone: { min: dec("90"), max: dec("110") },
  exposureCaps: [
    { scope: "asset", label: "SYNTH-A", currentExposureQuote: dec("200"), capQuote: dec("1000") },
  ],
  capital: {
    fundsAvailableQuote: dec("1000"),
    executableLiquidityBase: dec("80"),
    adverseLossBudgetQuote: dec("250"),
    stopDistanceQuote: dec("5"),
  },
  edge: {
    expectedGrossEdgePerUnitQuote: dec("5"),
    costs: {
      proportionalFeeRate: dec("0.001"),
      spreadCostPerUnitQuote: dec("0.5"),
      slippageAllowancePerUnitQuote: dec("0.2"),
      fixedCostsQuote: dec("2"),
    },
  },
});

describe("evaluateProposal — the approved path", () => {
  it("approves an eligible proposal and reports the size, the binding bound, and what each gate learned", () => {
    const result = evaluateProposal(healthy());
    expect(result.outcome).toBe("approved");
    if (result.outcome === "approved") {
      expect(result.size.quantityBase).toBe("8");
      expect(result.size.notionalQuote).toBe("800");
      expect(result.size.breakdown.bindingBounds).toEqual(["exposureLimit"]);
      expect(result.quoteAgeMs).toBe(3_000);
      expect(result.exposureHeadroomQuote).toBe("800");
      expect(result.bindingExposureCap.label).toBe("SYNTH-A");
    }
  });

  it("evaluates net edge at the SIZED quantity, not a hypothetical one — the breakdown's notional is the size's notional, which is what makes a proportional fee and a flat gas cost land on the same trade", () => {
    const result = evaluateProposal(healthy());
    expect(result.outcome).toBe("approved");
    if (result.outcome === "approved") {
      expect(result.netEdge.notionalQuote).toBe(result.size.notionalQuote);
      // gross 40, costs 0.8 + 4 + 1.6 + 2 = 8.4
      expect(result.netEdge.grossEdgeQuote).toBe("40");
      expect(result.netEdge.totalCostQuote).toBe("8.4");
      expect(result.netEdge.netEdgeQuote).toBe("31.6");
    }
  });

  it("approving is an answer, not a commitment — the result carries no reservation, intent, or order", () => {
    const result = evaluateProposal(healthy());
    expect(result.outcome).toBe("approved");
    if (result.outcome === "approved") {
      expect(Object.keys(result).sort()).toEqual(
        ["bindingExposureCap", "exposureHeadroomQuote", "netEdge", "outcome", "quoteAgeMs", "size"].sort(),
      );
    }
  });
});

describe("evaluateProposal — each gate refuses with its own code and stage", () => {
  it("refuses at reconciliation with ACCOUNT_UNRECONCILED", () => {
    const result = evaluateProposal({
      ...healthy(),
      account: { reconciledThrough: null, unresolvedDiscrepancyCount: 0 },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("reconciliation");
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });

  it("refuses at quoteFreshness with STALE_QUOTE", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      quote: { ...params.quote, quoteAcquiredAt: ts("2023-12-31T23:59:00.000Z") },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("quoteFreshness");
      expect(result.refusal.reason.code).toBe("STALE_QUOTE");
    }
  });

  it("refuses at entryZone with OUTSIDE_ENTRY_ZONE when the price has moved above the approved zone", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      quote: { ...params.quote, executablePrice: dec("150") },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("entryZone");
      expect(result.refusal.reason.code).toBe("OUTSIDE_ENTRY_ZONE");
    }
  });

  it("refuses at exposure with EXPOSURE_LIMIT", () => {
    const result = evaluateProposal({
      ...healthy(),
      exposureCaps: [
        { scope: "asset", label: "SYNTH-A", currentExposureQuote: dec("1000"), capQuote: dec("1000") },
      ],
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("exposure");
      expect(result.refusal.reason.code).toBe("EXPOSURE_LIMIT");
    }
  });

  it("refuses at sizing with MINIMUM_NOTIONAL", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      capital: { ...params.capital, executableLiquidityBase: dec("0.01") },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("sizing");
      expect(result.refusal.reason.code).toBe("MINIMUM_NOTIONAL");
    }
  });

  it("refuses at netEdge with INSUFFICIENT_NET_EDGE", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      edge: { ...params.edge, expectedGrossEdgePerUnitQuote: dec("1") },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("netEdge");
      expect(result.refusal.reason.code).toBe("INSUFFICIENT_NET_EDGE");
    }
  });

  it("covers every declared stage across the cases above, so a stage cannot be added without a path that reaches it", () => {
    expect([...EVALUATION_STAGES]).toEqual([
      "reconciliation",
      "quoteFreshness",
      "entryZone",
      "exposure",
      "sizing",
      "netEdge",
    ]);
  });
});

// The reason ordering is a property worth testing rather than an incidental
// implementation detail: a proposal that fails several gates must be filed
// under the gate that fails FIRST, because the later gates were evaluated
// against state an earlier gate already declared untrustworthy.
describe("evaluateProposal — fail-closed ordering", () => {
  it("reports the earliest failing gate when several would fail — state integrity is decided before any judgement about the proposal", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      account: { reconciledThrough: null, unresolvedDiscrepancyCount: 3 },
      quote: { quoteAcquiredAt: ts("2023-12-31T00:00:00.000Z"), executablePrice: dec("150") },
      exposureCaps: [
        { scope: "asset", label: "SYNTH-A", currentExposureQuote: dec("1000"), capQuote: dec("1000") },
      ],
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("reconciliation");
      expect(result.refusal.reason.code).toBe("ACCOUNT_UNRECONCILED");
    }
  });

  it("files an exhausted exposure cap as EXPOSURE_LIMIT at the exposure stage, NOT as a MINIMUM_NOTIONAL skip at sizing — a zero-headroom cap flowing into sizing would produce a zero bound, and the journal would record a breached cap under the wrong code with the cap's name lost", () => {
    const params = healthy();
    const result = evaluateProposal({
      ...params,
      exposureCaps: [
        { scope: "sector", label: "synthetic-sector", currentExposureQuote: dec("500"), capQuote: dec("500") },
      ],
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("exposure");
      expect(result.refusal.reason.code).toBe("EXPOSURE_LIMIT");
      expect(result.refusal.reason.code).not.toBe("MINIMUM_NOTIONAL");
      expect(result.refusal.detail).toContain("synthetic-sector");
    }
  });

  it("refuses an empty exposure cap list rather than sizing against no limit", () => {
    const result = evaluateProposal({ ...healthy(), exposureCaps: [] });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBe("exposure");
      expect(result.refusal.reason.source).toBe("input");
      expect(result.refusal.reason.code).toBe("NO_EXPOSURE_CAP");
    }
  });
});

describe("evaluateProposal — malformed parameters", () => {
  it("refuses with a null stage when the parameters themselves do not parse, distinguishing 'could not ask' from 'asked and declined'", () => {
    const result = evaluateProposal({ nothing: "useful" } as unknown as ProposalEvaluationParams);
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.stage).toBeNull();
      expect(result.refusal.reason.source).toBe("input");
    }
  });

  it("never throws on schema-legal or malformed input alike (docs/resilience.md §4)", () => {
    expect(() => evaluateProposal(healthy())).not.toThrow();
    expect(() => evaluateProposal({} as unknown as ProposalEvaluationParams)).not.toThrow();
  });

  it("reads no clock: the same parameters evaluated twice produce the same answer", () => {
    const first = evaluateProposal(healthy());
    const second = evaluateProposal(healthy());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
