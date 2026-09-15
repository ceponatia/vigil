import { describe, expect, it } from "vitest";

import { parseVenueExecutionConfig } from "./venue";
import { venueConfig } from "./test-support/execution-fixtures";

/**
 * The defect this file kills: a venue cost model that is absent, misspelled,
 * or nonsensical being read as a permissive one.
 *
 * A missing fee rate that became `0`, a typo'd field that was silently
 * discarded, or a negative flat cost would each make every trade look
 * cheaper than it is — the negative one would *raise* net edge and *enlarge*
 * every sizing bound. `docs/resilience.md` §1 says an unanswerable question
 * blocks new risk; this parser is where that holds for the cost model, the
 * way `parsePolicyConfig` already holds it for the limit set.
 *
 * The bounds are checked too, because they are the adapter's own: a
 * configuration this parser accepted and `createPaperExchange` would throw on
 * turns a diagnostic into an exception out of a constructor, which is not
 * something a caller can act on.
 */

const VALID: Record<string, unknown> = {
  venueId: "paper-synthetic",
  adapterCapabilityVersion: "paper-exchange-1",
  moneyScale: 2,
  quantityScale: 4,
  feeBasisPoints: 25,
  slippageBasisPoints: 10,
  fixedExecutionCostQuote: "0.50",
  costModelVersion: "cost-model-test-0",
  feeSnapshotVersion: "fee-snapshot-test-0",
};

function refusalFor(overrides: Record<string, unknown>): string | null {
  const parsed = parseVenueExecutionConfig({ ...VALID, ...overrides });
  return parsed.outcome === "refused" ? parsed.refusal.detail : null;
}

function withoutField(field: string): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...VALID };
  // `delete` rather than `undefined`: an absent field and a field explicitly
  // set to `undefined` are different inputs, and absence is the one a
  // forgotten configuration actually produces.
  Reflect.deleteProperty(raw, field);
  return raw;
}

describe("parseVenueExecutionConfig", () => {
  it("accepts the fixture model and hands back a value nothing can have built by hand", () => {
    const parsed = parseVenueExecutionConfig(VALID);

    expect(parsed.outcome).toBe("ok");
    if (parsed.outcome === "ok") {
      expect(parsed.venue).toEqual(venueConfig());
    }
  });

  it("refuses every missing field rather than defaulting it", () => {
    for (const field of Object.keys(VALID)) {
      const parsed = parseVenueExecutionConfig(withoutField(field));
      expect(parsed.outcome).toBe("refused");
      if (parsed.outcome === "refused") {
        expect(parsed.refusal.reason).toEqual({ source: "execution", code: "MALFORMED_VENUE_CONFIG" });
        expect(parsed.refusal.detail).toContain(field);
      }
    }
  });

  it("refuses an unknown key rather than discarding it, so a typo cannot hide a missing field", () => {
    expect(refusalFor({ feeBasisPoint: 25 })).not.toBeNull();
  });

  it("refuses a negative flat cost, which would raise net edge instead of reducing it", () => {
    expect(refusalFor({ fixedExecutionCostQuote: "-0.50" })).toContain("fixedExecutionCostQuote");
  });

  it("refuses a blank identity, so a record cannot name a venue that is not named", () => {
    expect(refusalFor({ venueId: "   " })).toContain("venueId");
    expect(refusalFor({ feeSnapshotVersion: "" })).toContain("feeSnapshotVersion");
  });

  it("refuses rates and scales outside the adapter's own bounds, so no accepted model can throw out of createPaperExchange", () => {
    expect(refusalFor({ feeBasisPoints: 10_001 })).toContain("feeBasisPoints");
    // Strictly under 10 000: a 100% adverse move is not slippage.
    expect(refusalFor({ slippageBasisPoints: 10_000 })).toContain("slippageBasisPoints");
    expect(refusalFor({ moneyScale: 19 })).toContain("moneyScale");
    expect(refusalFor({ quantityScale: -1 })).toContain("quantityScale");
    expect(refusalFor({ feeBasisPoints: 2.5 })).toContain("feeBasisPoints");
  });

  it("never throws on any input, however malformed", () => {
    for (const raw of [null, undefined, 7, "config", [], { venueId: 1 }]) {
      expect(() => parseVenueExecutionConfig(raw)).not.toThrow();
      expect(parseVenueExecutionConfig(raw).outcome).toBe("refused");
    }
  });
});
