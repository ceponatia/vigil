import { describe, expect, it } from "vitest";

import { revalidateBeforeDispatch, type ExecutableIntent, type RevalidationResult } from "./revalidate";
import { unitsAt } from "./venue-economics";
import {
  NOW,
  QUOTE_ACQUIRED_AT,
  exposureCap,
  money,
  planTerms,
  policyConfig,
  portfolio,
  rawQuote,
  syntheticInstrument,
  venueConfig,
} from "./test-support/execution-fixtures";

/**
 * The defects this file kills, each one a way an approved intent reaches a
 * venue on economics nobody re-checked:
 *
 *  * **Dispatching on the approval's own numbers.** The candidate having once
 *    been attractive is not sufficient. Every case here revalidates against a
 *    quote the approval never saw.
 *
 *  * **Freezing the gross edge.** A per-unit edge carried forward from
 *    discovery clears its hurdle forever, however far the market has moved
 *    toward the target. The edge is re-measured from the FRESH midpoint, and
 *    the decay case below is the one that would pass with a frozen figure.
 *
 *  * **Judging the entry zone at the ask.** The price actually paid is the
 *    execution price, which contains the spread and the slippage cap. A zone
 *    check against the ask admits a fill above the approved zone — chasing,
 *    through the one component whose "yes" spends money.
 *
 *  * **Treating a percentage edge as size-independent.** A flat cost does not
 *    scale, so the same per-unit edge that clears comfortably at a whole unit
 *    cannot clear at a fraction of one. A revalidation that only compared
 *    rates would approve the second.
 *
 *  * **Confusing a favourable price move with a profitable trade.** A better
 *    entry raises gross edge and changes no fixed cost at all.
 *
 * Pure unit cases: `revalidateBeforeDispatch` reads no clock and performs no
 * IO, so every one of them is a fixed input and a fixed answer.
 */

const VENUE = venueConfig();
const CONFIG = policyConfig();
const INSTRUMENT = syntheticInstrument("reval");

/** One whole unit, and a fraction of one, at the venue's quantity scale. */
const WHOLE_UNIT = 10_000n;
const TINY = 50n;

/**
 * A decimal compared by VALUE rather than by spelling.
 *
 * `@vigil/policy` renders every result canonically — trailing fractional
 * zeros stripped — so the exact spelling of a computed figure is that
 * package's formatting rather than this application's contract. Pinning the
 * string would make these cases fail on a rendering change that altered no
 * number at all (`docs/testing.md`: a literal is pinned only where the
 * literal is the contract).
 */
function atScale(value: string, scale = 9): bigint {
  const units = unitsAt(money(value), scale);
  if (units === null) {
    throw new Error(`"${value}" carries more precision than scale ${String(scale)}`);
  }
  return units;
}

function executableIntent(overrides: Partial<ExecutableIntent> = {}): ExecutableIntent {
  return {
    intentId: "intent-reval",
    side: "BUY",
    baseAssetId: INSTRUMENT.baseAssetId,
    quoteAssetId: INSTRUMENT.quoteAssetId,
    quantityUnits: WHOLE_UNIT,
    entryZone: planTerms().entryZone,
    requiredFreshnessMs: 60_000,
    ...overrides,
  };
}

function revalidate(options: {
  readonly intent?: Partial<ExecutableIntent>;
  readonly quote?: Parameters<typeof rawQuote>[1];
  readonly portfolio?: Parameters<typeof portfolio>[0];
  readonly quoteValue?: unknown;
} = {}): RevalidationResult {
  return revalidateBeforeDispatch({
    intent: executableIntent(options.intent ?? {}),
    thesis: planTerms().thesis,
    quote: options.quoteValue ?? rawQuote(INSTRUMENT, options.quote ?? {}),
    now: NOW,
    venue: VENUE,
    policyConfig: CONFIG,
    portfolio: portfolio(options.portfolio ?? {}),
  });
}

describe("revalidateBeforeDispatch", () => {
  it("clears a whole unit at the fresh book and carries the numbers it cleared on", () => {
    const result = revalidate();

    expect(result.outcome).toBe("cleared");
    if (result.outcome === "cleared") {
      expect(result.pricing.executionPrice).toBe("250.36");
      // Measured from the FRESH midpoint (250.05), not from anything the
      // approval computed: 260.00 - 250.05.
      expect(result.expectedGrossEdgePerUnitQuote).toBe("9.95");
      expect(result.costs.separatelyCharged.slippageAllowancePerUnitQuote).toBe("0");
      expect(result.envelope.quantityUnits).toBe(WHOLE_UNIT);
      expect(result.netEdge.minimumNetEdgeQuote).toBe(CONFIG.minimumNetEdgeQuote);
    }
  });

  it("re-measures gross edge against each quote's own midpoint rather than carrying one forward", () => {
    const atOpeningBook = revalidate();
    const atHigherBook = revalidate({ quote: { bidPrice: "255.00", askPrice: "255.10" } });

    expect(atOpeningBook.outcome).toBe("cleared");
    expect(atHigherBook.outcome).toBe("cleared");
    if (atOpeningBook.outcome === "cleared" && atHigherBook.outcome === "cleared") {
      // Same thesis target, different midpoint, therefore a different edge.
      // A frozen per-unit figure would make these equal.
      expect(atOpeningBook.expectedGrossEdgePerUnitQuote).toBe("9.95");
      expect(atHigherBook.expectedGrossEdgePerUnitQuote).toBe("4.95");
    }
  });

  it("blocks a stale quote with STALE_QUOTE at the intent's own freshness window, before any cost is computed", () => {
    const result = revalidate({
      intent: { requiredFreshnessMs: 500 },
      quote: { quoteAcquiredAt: "2026-03-01T11:59:00.000Z" },
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("quote");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "STALE_QUOTE" });
      expect(result.pricing).toBeNull();
    }
  });

  it("blocks a quote for another instrument as an execution diagnostic, never as a policy decision about the proposal", () => {
    const other = syntheticInstrument("revalother");
    const result = revalidate({ quoteValue: rawQuote(other) });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("instrument");
      expect(result.refusal.reason).toEqual({ source: "execution", code: "QUOTE_INSTRUMENT_MISMATCH" });
    }
  });

  it("judges the entry zone at the price actually paid, not at the ask — a zone the ask clears and the execution price does not is a refusal", () => {
    // The ask is 250.10 and sits inside this zone; the execution price is
    // 250.36 and does not. Checking the ask would dispatch a fill above the
    // approved zone.
    const result = revalidate({ intent: { entryZone: { min: money("200.00"), max: money("250.30") } } });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("entryZone");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "OUTSIDE_ENTRY_ZONE" });
    }
  });

  it("blocks unreconciled balances before it looks at the market at all", () => {
    const result = revalidate({
      portfolio: { account: { reconciledThrough: null, unresolvedDiscrepancyCount: 0 } },
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("reconciliation");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "ACCOUNT_UNRECONCILED" });
    }
  });

  it("blocks a cap with no headroom under EXPOSURE_LIMIT rather than letting it reach the economics", () => {
    const result = revalidate({
      portfolio: { exposureCaps: [exposureCap({ currentExposureQuote: money("10000.00") })] },
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("exposure");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "EXPOSURE_LIMIT" });
    }
  });

  it("blocks an edge that decayed between approval and dispatch, and keeps the arithmetic that failed", () => {
    // Same thesis target, same quantity, same costs model. The midpoint has
    // risen to 257.55, leaving 2.45 of gross edge against 1.45 of cost — a
    // net 0.99 that no longer reaches the 1.00 hurdle.
    const result = revalidate({ quote: { bidPrice: "257.50", askPrice: "257.60" } });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("netEdge");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "INSUFFICIENT_NET_EDGE" });
      // The durable record needs the numbers, not just the verdict.
      expect(result.netEdge).not.toBeNull();
      const netEdge = result.netEdge;
      expect(netEdge).not.toBeNull();
      if (netEdge !== null) {
        // 2.45 gross less 1.45465 of cost: 0.99535, just under the 1.00 hurdle.
        expect(atScale(netEdge.netEdgeQuote)).toBe(995_350_000n);
        expect(atScale(netEdge.netEdgeQuote)).toBeLessThan(atScale(netEdge.minimumNetEdgeQuote));
      }
      expect(result.pricing?.executionPrice).toBe("257.86");
    }
  });

  it("blocks a small-notional trade a flat cost has made uneconomic, at a per-unit edge that clears comfortably at a whole unit", () => {
    const book = { bidPrice: "250.00", askPrice: "250.10" } as const;
    const tiny = revalidate({ intent: { quantityUnits: TINY }, quote: book });
    const whole = revalidate({ intent: { quantityUnits: WHOLE_UNIT }, quote: book });

    expect(whole.outcome).toBe("cleared");
    expect(tiny.outcome).toBe("blocked");
    if (tiny.outcome === "blocked") {
      expect(tiny.stage).toBe("netEdge");
      expect(tiny.refusal.reason).toEqual({ source: "policy", code: "INSUFFICIENT_NET_EDGE" });
      const netEdge = tiny.netEdge;
      expect(netEdge).not.toBeNull();
      if (netEdge !== null) {
        // The flat cost alone exceeds the whole gross edge at this size.
        expect(netEdge.fixedCostsQuote).toBe("0.50");
        expect(atScale(netEdge.grossEdgeQuote)).toBe(49_750_000n);
        expect(atScale(netEdge.fixedCostsQuote)).toBeGreaterThan(atScale(netEdge.grossEdgeQuote));
      }
    }
  });

  it("blocks a trade whose price moved in its favour and whose economics are still net-negative after costs", () => {
    // The ask fell from 250.10 to 240.10, so gross edge per unit ROSE from
    // 9.95 to 19.95. At this notional the flat cost still eats all of it.
    const result = revalidate({
      intent: { quantityUnits: TINY },
      quote: { bidPrice: "240.00", askPrice: "240.10" },
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("netEdge");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "INSUFFICIENT_NET_EDGE" });
      const netEdge = result.netEdge;
      expect(netEdge).not.toBeNull();
      if (netEdge !== null) {
        // Gross edge per unit ROSE to 19.95 and the trade is still under water.
        expect(atScale(netEdge.grossEdgeQuote)).toBe(99_750_000n);
        expect(atScale(netEdge.netEdgeQuote)).toBeLessThan(0n);
      }
    }
  });

  it("blocks a crossed book as corrupt market state rather than pricing against it", () => {
    const result = revalidate({ quote: { bidPrice: "250.20", askPrice: "250.10" } });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("pricing");
      expect(result.refusal.reason).toEqual({ source: "execution", code: "CROSSED_QUOTE_BOOK" });
    }
  });

  it("blocks a quote that did not parse at all under STALE_QUOTE, never by throwing", () => {
    const result = revalidate({ quoteValue: { instrumentId: "BTC-USD", bidPrice: "1" } });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.stage).toBe("quote");
      expect(result.refusal.reason).toEqual({ source: "policy", code: "STALE_QUOTE" });
    }
  });

  it("uses the quote's acquisition time and never a clock of its own", () => {
    // Same inputs, called twice: a function that read a clock would make one
    // of these stale eventually, and the property this suite depends on is
    // that it cannot.
    expect(revalidate()).toEqual(revalidate());
  });
});

describe("QUOTE_ACQUIRED_AT", () => {
  it("is before the injected now, so the fixture quote is fresh by construction", () => {
    expect(new Date(QUOTE_ACQUIRED_AT).getTime()).toBeLessThan(new Date(NOW).getTime());
  });
});
