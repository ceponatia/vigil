import { describe, expect, it } from "vitest";

import { ACKNOWLEDGE_AND_FILL, proposeOrder, reserveOrder, settlementOf, validateOrder } from "@vigil/adapter-paper";
import type { PaperOrder } from "@vigil/adapter-paper";
import { checkNetEdge, sizeTrade } from "@vigil/policy";

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  NOW,
  money,
  paperExchange,
  parsedQuote,
  policyConfig,
  rawQuote,
  syntheticInstrument,
  venueConfig,
} from "./test-support/execution-fixtures";
import { decimalAt, envelopeFor, netEdgeCostsFor, priceExecutable, unitsAt } from "./venue-economics";

/**
 * The defects this file kills:
 *
 *  * **The cost model drifting from the venue's.** `apps/trading` computes
 *    `maxSpend` itself — an application that asked the venue what it was
 *    about to be charged and wrote that down as its own ceiling would have no
 *    ceiling. Two computations that must agree can stop agreeing, and the
 *    symptom is an authorization that is durable and can never be dispatched,
 *    because the adapter refuses it with `MAX_SPEND_EXCEEDED`. The case below
 *    drives a real `createPaperExchange` at the same configuration and
 *    compares the settled fill against the envelope to the unit.
 *
 *  * **Counting an embedded cost twice.** `executionPrice` already contains
 *    the spread and the slippage cap, so adding them to the notional is the
 *    single most plausible way to overstate what a trade costs — and, in
 *    `sizeTrade`'s capital bound, to under-size every trade. The case below
 *    computes the double-counted figure explicitly and asserts the real one
 *    is not it.
 *
 *  * **Under-bounding the fee.** The other self-consistent wiring — handing
 *    policy the ask and calling slippage separately charged — applies the fee
 *    rate to a notional at the ask while the venue charges it on the notional
 *    at the execution price. The shortfall is small and real, and it makes
 *    `sizeTrade` approve a quantity whose cash out exceeds the funds
 *    available. The case below pins the boundary: funds exactly equal to the
 *    envelope size the whole quantity, and one unit less do not.
 *
 * Pure unit cases: the paper exchange is deterministic, reads no clock, and
 * reaches nothing.
 */

const VENUE = venueConfig();
const CONFIG = policyConfig();
const INSTRUMENT = syntheticInstrument("econ");
const QUANTITY = money("1.0000");

function pricingOrThrow(overrides: Parameters<typeof rawQuote>[1] = {}) {
  const priced = priceExecutable("BUY", parsedQuote(INSTRUMENT, overrides), VENUE);
  if (priced.outcome === "unpriceable") {
    throw new Error(`fixture quote is unpriceable: ${priced.failure.detail}`);
  }
  return priced.pricing;
}

function unitsOrThrow(value: string, scale: number): bigint {
  const units = unitsAt(money(value), scale);
  if (units === null) {
    throw new Error(`"${value}" does not fit scale ${String(scale)}`);
  }
  return units;
}

describe("priceExecutable", () => {
  it("prices from the executable side and the midpoint the spread is measured against, never from a last-trade price", () => {
    const pricing = pricingOrThrow();

    // `referenceBid`/`referenceAsk` carry the quote's own spelling; every
    // price this module derives is rendered canonically, so `250.10` and
    // `250.1` are the same price written twice. Compared by value, as every
    // money comparison in this workspace is.
    expect(pricing.referenceAsk).toBe("250.10");
    expect(unitsOrThrow(pricing.referencePrice, MONEY_SCALE)).toBe(unitsOrThrow(pricing.referenceAsk, MONEY_SCALE));
    // Rounded DOWN for a buy, so the measured spread can never be understated.
    expect(pricing.referenceMid).toBe("250.05");
    // The ask moved 10bp against the caller, rounded up.
    expect(pricing.executionPrice).toBe("250.36");
    expect(pricing.spreadPerUnitQuote).toBe("0.05");
    expect(pricing.slippagePerUnitQuote).toBe("0.26");
    expect(pricing.embeddedPerUnitQuote).toBe("0.31");
    expect(pricing.proportionalFeeRate).toBe("0.0025");
  });

  it("refuses a crossed book rather than pricing against corrupt market state", () => {
    const priced = priceExecutable("BUY", parsedQuote(INSTRUMENT, { bidPrice: "250.20", askPrice: "250.10" }), VENUE);

    expect(priced.outcome).toBe("unpriceable");
    if (priced.outcome === "unpriceable") {
      expect(priced.failure.reason).toBe("CROSSED_QUOTE_BOOK");
    }
  });

  it("measures the spread from the bid for a sell, so neither component can come out negative", () => {
    const priced = priceExecutable("SELL", parsedQuote(INSTRUMENT), VENUE);

    expect(priced.outcome).toBe("priced");
    if (priced.outcome === "priced") {
      expect(unitsOrThrow(priced.pricing.referencePrice, MONEY_SCALE)).toBe(25_000n);
      // Rounded UP for a sell: its spread is `mid - bid`.
      expect(priced.pricing.referenceMid).toBe("250.05");
      expect(priced.pricing.executionPrice).toBe("249.75");
      expect(priced.pricing.spreadPerUnitQuote).toBe("0.05");
      expect(priced.pricing.slippagePerUnitQuote).toBe("0.25");
    }
  });
});

describe("netEdgeCostsFor", () => {
  it("puts both costs the execution price already contains in the embedded group and leaves the slippage allowance at zero", () => {
    const pricing = pricingOrThrow();
    const costs = netEdgeCostsFor(pricing);

    // The whole no-double-charge contract in one place: the price handed to
    // policy is `executionPrice`, so charging slippage on top of the notional
    // would deduct it once through the price and again through the bound.
    expect(costs.embedded.spreadCostPerUnitQuote).toBe("0.31");
    expect(costs.separatelyCharged.slippageAllowancePerUnitQuote).toBe("0");
    expect(costs.separatelyCharged.proportionalFeeRate).toBe("0.0025");
    expect(costs.separatelyCharged.fixedCostsQuote).toBe("0.50");
  });

  it("gives checkNetEdge a breakdown whose embedded block is counted exactly once", () => {
    const pricing = pricingOrThrow();
    const result = checkNetEdge({
      quantity: QUANTITY,
      executablePrice: pricing.executionPrice,
      expectedGrossEdgePerUnitQuote: money("9.95"),
      costs: netEdgeCostsFor(pricing),
      config: CONFIG,
    });

    expect(result.eligible).toBe(true);
    const breakdown = result.breakdown;
    expect(breakdown).not.toBeNull();
    if (breakdown !== null) {
      // `0.31` per unit at one unit, and nothing anywhere else claiming it.
      expect(unitsOrThrow(breakdown.spreadCostQuote, MONEY_SCALE)).toBe(31n);
      expect(unitsOrThrow(breakdown.slippageAllowanceQuote, MONEY_SCALE)).toBe(0n);
      expect(unitsOrThrow(breakdown.fixedCostsQuote, MONEY_SCALE)).toBe(50n);
    }
  });
});

describe("envelopeFor against the real paper exchange", () => {
  function filledOrderFor(maxSpend: string): PaperOrder {
    const exchange = paperExchange({ defaultBehavior: ACKNOWLEDGE_AND_FILL });
    const proposed = proposeOrder({
      intent: {
        intentId: "intent-econ",
        economicActionId: "action-econ",
        positionPlanId: "plan-econ",
        idempotencyKey: "idem-econ",
        correlationId: "corr-econ",
        venueId: VENUE.venueId,
        action: "BUY",
        inputAssetId: INSTRUMENT.quoteAssetId,
        outputAssetId: INSTRUMENT.baseAssetId,
        quantity: QUANTITY,
        maxSpend,
        minAcceptableReceipt: "0.0001",
        permittedResidual: "0.0001",
        validUntil: "2026-03-01T13:00:00.000Z",
        requiredFreshnessMs: 60_000,
        adapterCapabilityVersion: VENUE.adapterCapabilityVersion,
        policyVersion: "policy-test-0",
        strategyVersion: "strategy-test-0",
        modelVersion: null,
        portfolioSnapshotVersion: "portfolio-snapshot-test-0",
        marketSnapshotVersion: "market-snapshot-test-0",
        feeSnapshotVersion: "fee-snapshot-test-0",
      },
      at: NOW,
      attempt: 1,
    });
    if (!proposed.accepted) {
      throw new Error(`fixture order was refused: ${proposed.refusal.detail}`);
    }
    const validated = validateOrder(proposed.order, NOW);
    if (!validated.applied) {
      throw new Error("fixture order could not be validated");
    }
    const reserved = reserveOrder(validated.order, NOW);
    if (!reserved.applied) {
      throw new Error("fixture order could not be reserved");
    }

    const submitted = exchange.submitOrder({ order: reserved.order, quote: rawQuote(INSTRUMENT), now: NOW });
    if (submitted.outcome !== "ACKNOWLEDGED") {
      throw new Error(`fixture order was not acknowledged: ${submitted.outcome}`);
    }
    const polled = exchange.pollOrder({ order: submitted.order, now: NOW });
    if (polled.outcome !== "UPDATED") {
      throw new Error(`fixture order did not fill: ${polled.outcome}`);
    }
    return polled.order;
  }

  it("bounds a complete fill exactly — a drifting mirror of the venue's arithmetic would show up as an authorization that can never be dispatched", () => {
    const pricing = pricingOrThrow();
    const envelope = envelopeFor(pricing, unitsOrThrow("1.0000", QUANTITY_SCALE));
    const order = filledOrderFor(decimalAt(envelope.maxSpendUnits, MONEY_SCALE));
    const settled = settlementOf(order);

    expect(settled.state).toBe("FILLED");
    expect(settled.economics.netCapitalConsumed).toBe(decimalAt(envelope.maxSpendUnits, MONEY_SCALE));
    expect(settled.economics.grossNotional).toBe(decimalAt(envelope.notionalUnits, MONEY_SCALE));
    expect(settled.economics.executionPrice).toBe(pricing.executionPrice);
  });

  it("does not add the embedded costs to the notional a second time", () => {
    const pricing = pricingOrThrow();
    const envelope = envelopeFor(pricing, unitsOrThrow("1.0000", QUANTITY_SCALE));
    const settled = settlementOf(filledOrderFor(decimalAt(envelope.maxSpendUnits, MONEY_SCALE)));

    const gross = unitsOrThrow(settled.economics.grossNotional, MONEY_SCALE);
    const total = unitsOrThrow(settled.economics.totalIncrementalCost, MONEY_SCALE);
    const embedded = unitsOrThrow(settled.economics.embeddedCost, MONEY_SCALE);
    const net = unitsOrThrow(settled.economics.netCapitalConsumed ?? "0", MONEY_SCALE);

    // The double count, written out: gross ALREADY contains `embedded`.
    expect(gross + total).toBe(net + embedded);
    expect(gross + total).toBeGreaterThan(net);
    expect(net).toBe(envelope.maxSpendUnits);
  });
});

describe("the capital bound policy solves against this cost model", () => {
  const pricing = pricingOrThrow();
  const envelope = envelopeFor(pricing, unitsOrThrow("1.0000", QUANTITY_SCALE));

  function sizeWithFunds(fundsAvailableQuote: string): string | null {
    const sized = sizeTrade({
      inputs: {
        fundsAvailableQuote: money(fundsAvailableQuote),
        // Every other bound deliberately out of the way, so the funds bound
        // is the one being measured.
        exposureHeadroomQuote: money("1000000.00"),
        executableLiquidityBase: money("1000.0000"),
        adverseLossBudgetQuote: money("1000000.00"),
        stopDistanceQuote: money("10.00"),
        executablePrice: pricing.executionPrice,
      },
      costs: netEdgeCostsFor(pricing),
      config: CONFIG,
    });
    return sized.outcome === "sized" ? sized.size.quantityBase : null;
  }

  it("covers the whole quantity at exactly the envelope, and not at one unit less", () => {
    const exact = decimalAt(envelope.maxSpendUnits, MONEY_SCALE);
    const short = decimalAt(envelope.maxSpendUnits - 1n, MONEY_SCALE);

    const atExact = sizeWithFunds(exact);
    const atShort = sizeWithFunds(short);

    expect(atExact).not.toBeNull();
    expect(atShort).not.toBeNull();
    if (atExact !== null && atShort !== null) {
      expect(unitsOrThrow(atExact, QUANTITY_SCALE)).toBeGreaterThanOrEqual(unitsOrThrow("1.0000", QUANTITY_SCALE));
      expect(unitsOrThrow(atShort, QUANTITY_SCALE)).toBeLessThan(unitsOrThrow("1.0000", QUANTITY_SCALE));
    }
  });
});
