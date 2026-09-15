import { describe, expect, it } from "vitest";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { createPaperExchange } from "./exchange";
import type { PaperExchange, PaperExchangeConfig } from "./exchange";
import { COST_COMPONENTS, COST_COMPONENT_CHARGING } from "./execution-economics";
import type { CostComponent, ExecutionEconomics } from "./execution-economics";
import { settlementOf } from "./order";
import type { OrderSettlement, PaperOrder } from "./order";
import {
  AT_SUBMITTED,
  SELL_INTENT,
  TEST_EXCHANGE_CONFIG,
  afterAcceptance,
  rawQuote,
  reservedOrder,
} from "./test-support/order-fixtures";

const d = (value: string): DecimalString => decimalStringSchema.parse(value);

/**
 * The defects this file kills, in order of how much money they cost:
 *
 * 1. **A fill that costs more than the approved ceiling.** The previous
 *    revision rounded every execution independently, so a quantity approved
 *    at a `maxSpend` of `0.09` cost `0.12` when the venue delivered it in
 *    three steps instead of one — the submission check proved a bound that
 *    stepped fills did not obey. `"a stepped fill costs exactly what the same
 *    quantity costs filled at once"` below is that regression.
 * 2. **A cost counted twice.** Spread and slippage are already inside the
 *    execution price. A caller that reads `grossNotional` and then also
 *    subtracts the spread has charged it twice and will refuse trades that
 *    were fine. Every fixture here asserts the exact identity that makes
 *    double-charging detectable: a buy's `netCapitalConsumed` is its
 *    `grossAtReferenceMid` PLUS `totalIncrementalCost`, and a sell's
 *    `netProceeds` is its `grossAtReferenceMid` MINUS it — never gross plus
 *    the embedded components again.
 * 3. **A favourable price move that is not actually profitable.** The round
 *    trip at the bottom is issue #33's stated purpose: the midpoint rises
 *    20 cents and the trade still loses 42.
 */

type Fixture = {
  readonly config: Partial<PaperExchangeConfig>;
  readonly bidPrice: string;
  readonly askPrice: string;
};

function exchangeFor(fixture: Fixture): PaperExchange {
  return createPaperExchange({ ...TEST_EXCHANGE_CONFIG, ...fixture.config });
}

/** Submits and fully fills one order, returning its settlement. */
function fill(fixture: Fixture, intentOverrides: Record<string, unknown> = {}): OrderSettlement {
  const exchange = exchangeFor(fixture);
  return settlementOf(filledOrder(exchange, fixture, intentOverrides));
}

function filledOrder(
  exchange: PaperExchange,
  fixture: Fixture,
  intentOverrides: Record<string, unknown> = {},
  offsetsMs: readonly number[] = [0],
): PaperOrder {
  const submitted = exchange.submitOrder({
    order: reservedOrder(intentOverrides),
    quote: rawQuote({ bidPrice: fixture.bidPrice, askPrice: fixture.askPrice }),
    now: AT_SUBMITTED,
  });
  if (submitted.outcome !== "ACKNOWLEDGED") {
    throw new Error(`fixture failed to submit: ${submitted.outcome}`);
  }

  let order = submitted.order;
  for (const offset of offsetsMs) {
    const polled = exchange.pollOrder({ order, now: afterAcceptance(offset) });
    if (polled.outcome === "REFUSED") {
      throw new Error(`fixture failed to poll: ${polled.refusal.reason.code} — ${polled.refusal.detail}`);
    }
    order = polled.order;
  }
  return order;
}

function costOf(economics: ExecutionEconomics, component: CostComponent): DecimalString {
  const found = economics.costs.find((cost) => cost.component === component);
  if (found === undefined) {
    throw new Error(`the breakdown does not report a ${component} component at all`);
  }
  return found.amount;
}

/**
 * The identity that makes "counted once" machine-checkable. Every cost — the
 * ones embedded in the price and the ones charged on top — is accounted for
 * exactly once against a costless fill at the midpoint.
 */
function expectCostsCountedOnce(settlement: OrderSettlement, side: "BUY" | "SELL"): void {
  const { economics } = settlement;
  const mid = economics.grossAtReferenceMid;
  const total = economics.totalIncrementalCost;
  if (side === "BUY") {
    expect(economics.netProceeds).toBeNull();
    expect(economics.netCapitalConsumed).toBe(addCents(mid, total));
    // The embedded half is inside grossNotional and is NOT added again.
    expect(economics.netCapitalConsumed).toBe(addCents(economics.grossNotional, economics.separatelyChargedCost));
  } else {
    expect(economics.netCapitalConsumed).toBeNull();
    expect(economics.netProceeds).toBe(subtractCents(mid, total));
    expect(economics.netProceeds).toBe(subtractCents(economics.grossNotional, economics.separatelyChargedCost));
  }
  expect(economics.totalIncrementalCost).toBe(addCents(economics.embeddedCost, economics.separatelyChargedCost));
}

// Exact two-place decimal arithmetic for the assertions themselves, so a test
// never states an expected total as a float.
function cents(value: DecimalString): bigint {
  const [whole, fraction] = value.split(".");
  const sign = value.startsWith("-") ? -1n : 1n;
  const magnitude = BigInt((whole ?? "0").replace("-", "")) * 100n + BigInt((fraction ?? "00").padEnd(2, "0"));
  return sign * magnitude;
}

function renderCents(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function addCents(left: DecimalString, right: DecimalString): string {
  return renderCents(cents(left) + cents(right));
}

function subtractCents(left: DecimalString, right: DecimalString): string {
  return renderCents(cents(left) - cents(right));
}

describe("the cost fixtures issue #33 names, each proving its component is counted once", () => {
  it("no-cost baseline: a zero spread, zero fee, zero slippage fill costs exactly the midpoint", () => {
    const settlement = fill({ config: { feeBasisPoints: 0 }, bidPrice: "250.00", askPrice: "250.00" });
    expect(settlement.economics.grossAtReferenceMid).toBe("500.00");
    expect(settlement.economics.grossNotional).toBe("500.00");
    expect(settlement.economics.totalIncrementalCost).toBe("0.00");
    expect(settlement.economics.netCapitalConsumed).toBe("500.00");
    expect(settlement.economics.netCashFlow).toBe("-500.00");
    for (const component of COST_COMPONENTS) {
      expect(costOf(settlement.economics, component)).toBe("0.00");
    }
    expectCostsCountedOnce(settlement, "BUY");
  });

  it("spread only: crossing to the ask costs the half-spread and nothing else", () => {
    const settlement = fill({ config: { feeBasisPoints: 0 }, bidPrice: "250.00", askPrice: "250.10" });
    expect(settlement.economics.referenceMid).toBe("250.05");
    expect(settlement.economics.executionPrice).toBe("250.10");
    expect(costOf(settlement.economics, "SPREAD")).toBe("0.10");
    expect(costOf(settlement.economics, "SLIPPAGE")).toBe("0.00");
    expect(costOf(settlement.economics, "VENUE_FEE")).toBe("0.00");
    expect(settlement.economics.embeddedCost).toBe("0.10");
    expect(settlement.economics.separatelyChargedCost).toBe("0.00");
    // The spread is inside the 500.20 gross; the net is NOT 500.30.
    expect(settlement.economics.grossNotional).toBe("500.20");
    expect(settlement.economics.netCapitalConsumed).toBe("500.20");
    expectCostsCountedOnce(settlement, "BUY");
  });

  it("percentage fee: a 25bp fee is charged on top of the notional, not inside it", () => {
    const settlement = fill({ config: { feeBasisPoints: 25 }, bidPrice: "250.00", askPrice: "250.00" });
    expect(costOf(settlement.economics, "VENUE_FEE")).toBe("1.25");
    expect(COST_COMPONENT_CHARGING.VENUE_FEE).toBe("SEPARATELY_CHARGED");
    expect(settlement.economics.grossNotional).toBe("500.00");
    expect(settlement.economics.netCapitalConsumed).toBe("501.25");
    expectCostsCountedOnce(settlement, "BUY");
  });

  it("fixed cost: a flat modeled cost is charged once, and only when something filled", () => {
    const fixture: Fixture = {
      config: { feeBasisPoints: 0, fixedExecutionCost: d("0.50") },
      bidPrice: "250.00",
      askPrice: "250.00",
    };
    const settlement = fill(fixture);
    expect(costOf(settlement.economics, "FIXED_COST")).toBe("0.50");
    expect(settlement.economics.netCapitalConsumed).toBe("500.50");
    expectCostsCountedOnce(settlement, "BUY");

    // Cancelled without a fill: a cancellation invents no cost on the
    // confirmed unfilled remainder.
    const exchange = createPaperExchange({
      ...TEST_EXCHANGE_CONFIG,
      ...fixture.config,
      defaultBehavior: { submission: { kind: "ACKNOWLEDGE" }, executions: { kind: "NONE" }, cancellation: { kind: "CONFIRM" } },
    });
    const submitted = exchange.submitOrder({
      order: reservedOrder(),
      quote: rawQuote({ bidPrice: fixture.bidPrice, askPrice: fixture.askPrice }),
      now: AT_SUBMITTED,
    });
    if (submitted.outcome !== "ACKNOWLEDGED") {
      throw new Error(`fixture failed to submit: ${submitted.outcome}`);
    }
    const canceled = exchange.cancelOrder({ order: submitted.order, now: afterAcceptance(1_000) });
    if (canceled.outcome !== "CANCELED") {
      throw new Error(`fixture failed to cancel: ${canceled.outcome}`);
    }
    const unfilled = settlementOf(canceled.order);
    expect(unfilled.economics.filledQuantity).toBe("0.0000");
    expect(costOf(unfilled.economics, "FIXED_COST")).toBe("0.00");
    expect(unfilled.economics.totalIncrementalCost).toBe("0.00");
    expect(unfilled.releasableRemainder).toBe("2.0000");
  });

  it("embedded price impact: slippage is inside the price and is never deducted a second time", () => {
    const settlement = fill(
      { config: { feeBasisPoints: 0, slippageBasisPoints: 100 }, bidPrice: "250.00", askPrice: "250.00" },
    );
    expect(settlement.economics.referencePrice).toBe("250.00");
    expect(settlement.economics.executionPrice).toBe("252.50");
    expect(costOf(settlement.economics, "SLIPPAGE")).toBe("5.00");
    expect(COST_COMPONENT_CHARGING.SLIPPAGE).toBe("EMBEDDED_IN_PRICE");
    expect(settlement.economics.grossNotional).toBe("505.00");
    // 505.00, not 510.00: the 5.00 is already in the gross.
    expect(settlement.economics.netCapitalConsumed).toBe("505.00");
    expect(settlement.economics.grossAtReferenceMid).toBe("500.00");
    expectCostsCountedOnce(settlement, "BUY");
  });

  it("partial fill: economics accrue only on the quantity actually filled", () => {
    const exchange = createPaperExchange({
      ...TEST_EXCHANGE_CONFIG,
      defaultBehavior: {
        submission: { kind: "ACKNOWLEDGE" },
        executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
        cancellation: { kind: "CONFIRM" },
      },
    });
    const order = filledOrder(exchange, { config: {}, bidPrice: "250.00", askPrice: "250.10" });
    const settlement = settlementOf(order);

    expect(settlement.economics.filledQuantity).toBe("0.5000");
    expect(settlement.economics.unfilledQuantity).toBe("1.5000");
    expect(settlement.economics.grossNotional).toBe("125.05");
    expect(costOf(settlement.economics, "VENUE_FEE")).toBe("0.32");
    expect(costOf(settlement.economics, "SPREAD")).toBe("0.02");
    expect(settlement.economics.netCapitalConsumed).toBe("125.37");
    expectCostsCountedOnce(settlement, "BUY");
  });
});

describe("rounding at venue precision never invents profit and never leaves the approved envelope", () => {
  const smallBuy = { quantity: "0.0003", maxSpend: "0.09" };

  it("a stepped fill costs exactly what the same quantity costs filled at once", () => {
    // The regression. Three executions of 0.0001 at 250.10 with a 25bp fee
    // used to cost 0.12 against a ceiling of 0.09, because each execution
    // rounded up on its own.
    const stepped = createPaperExchange({
      ...TEST_EXCHANGE_CONFIG,
      defaultBehavior: {
        submission: { kind: "ACKNOWLEDGE" },
        executions: {
          kind: "STEPS",
          steps: [
            { quantity: d("0.0001"), afterMs: 0 },
            { quantity: d("0.0001"), afterMs: 0 },
            { quantity: d("0.0001"), afterMs: 0 },
          ],
        },
        cancellation: { kind: "CONFIRM" },
      },
    });
    const steppedOrder = filledOrder(stepped, { config: {}, bidPrice: "250.00", askPrice: "250.10" }, smallBuy);
    const steppedSettlement = settlementOf(steppedOrder);

    expect(steppedOrder.state).toBe("FILLED");
    expect(steppedOrder.executions).toHaveLength(3);
    expect(steppedSettlement.economics.netCapitalConsumed).toBe("0.09");
    // Not above the ceiling the submission check approved.
    expect(cents(d(steppedSettlement.economics.netCapitalConsumed ?? "0"))).toBeLessThanOrEqual(cents(d(smallBuy.maxSpend)));

    const single = fill({ config: {}, bidPrice: "250.00", askPrice: "250.10" }, smallBuy);
    expect(steppedSettlement.economics.grossNotional).toBe(single.economics.grossNotional);
    expect(steppedSettlement.economics.netCapitalConsumed).toBe(single.economics.netCapitalConsumed);
    expect(costOf(steppedSettlement.economics, "VENUE_FEE")).toBe(costOf(single.economics, "VENUE_FEE"));
  });

  it("reports each execution as an exact increment, so the increments sum to the total", () => {
    const stepped = createPaperExchange({
      ...TEST_EXCHANGE_CONFIG,
      defaultBehavior: {
        submission: { kind: "ACKNOWLEDGE" },
        executions: {
          kind: "STEPS",
          steps: [
            { quantity: d("0.0001"), afterMs: 0 },
            { quantity: d("0.0001"), afterMs: 0 },
            { quantity: d("0.0001"), afterMs: 0 },
          ],
        },
        cancellation: { kind: "CONFIRM" },
      },
    });
    const order = filledOrder(stepped, { config: {}, bidPrice: "250.00", askPrice: "250.10" }, smallBuy);
    // Equal quantities, unequal notionals, and a fee on only the first: each
    // execution reports its own increment of an exact running total rather
    // than an independent rounding of itself.
    expect(order.executions.map((execution) => [execution.quantity, execution.notional, execution.fee])).toEqual([
      ["0.0001", "0.03", "0.01"],
      ["0.0001", "0.03", "0.00"],
      ["0.0001", "0.02", "0.00"],
    ]);
  });

  it("a tiny sell never yields more than a costless fill at the midpoint", () => {
    const settlement = fill({ config: {}, bidPrice: "250.00", askPrice: "250.10" }, {
      ...SELL_INTENT,
      quantity: "0.0003",
      minAcceptableReceipt: "0.05",
    });
    expect(settlement.economics.netProceeds).toBe("0.06");
    expect(cents(d(settlement.economics.netProceeds ?? "0"))).toBeLessThanOrEqual(
      cents(d(settlement.economics.grossAtReferenceMid)),
    );
    expectCostsCountedOnce(settlement, "SELL");
  });
});

describe("a favourable price move that does not survive its costs", () => {
  it("shows a round trip as a loss even though the midpoint rose", () => {
    // The purpose issue #33 states in its Outcome paragraph: small-trade
    // costs must be visible rather than letting a favourable move look
    // profitable. The midpoint goes 100.05 -> 100.25, up 0.20. The round
    // trip loses 0.42.
    const exchange = createPaperExchange({ ...TEST_EXCHANGE_CONFIG });

    const bought = exchange.submitOrder({
      order: reservedOrder({ quantity: "1.0000", maxSpend: "101.00" }),
      quote: rawQuote({ bidPrice: "100.00", askPrice: "100.10" }),
      now: AT_SUBMITTED,
    });
    if (bought.outcome !== "ACKNOWLEDGED") {
      throw new Error(`buy leg failed: ${bought.outcome}`);
    }
    const buyPolled = exchange.pollOrder({ order: bought.order, now: afterAcceptance(0) });
    const buy = settlementOf(buyPolled.order);

    const sold = exchange.submitOrder({
      order: reservedOrder({ ...SELL_INTENT, idempotencyKey: "idem-0002", quantity: "1.0000", minAcceptableReceipt: "99.00" }),
      quote: rawQuote({ bidPrice: "100.20", askPrice: "100.30" }),
      now: AT_SUBMITTED,
    });
    if (sold.outcome !== "ACKNOWLEDGED") {
      throw new Error(`sell leg failed: ${sold.outcome}`);
    }
    const sellPolled = exchange.pollOrder({ order: sold.order, now: afterAcceptance(0) });
    const sell = settlementOf(sellPolled.order);

    expect(buy.economics.grossAtReferenceMid).toBe("100.05");
    expect(sell.economics.grossAtReferenceMid).toBe("100.25");
    expect(subtractCents(sell.economics.grossAtReferenceMid, buy.economics.grossAtReferenceMid)).toBe("0.20");

    expect(buy.economics.netCapitalConsumed).toBe("100.36");
    expect(sell.economics.netProceeds).toBe("99.94");
    expect(addCents(buy.economics.netCashFlow, sell.economics.netCashFlow)).toBe("-0.42");

    // The whole 0.62 of cost is visible and attributed, not a residue.
    expect(addCents(buy.economics.totalIncrementalCost, sell.economics.totalIncrementalCost)).toBe("0.62");
    expectCostsCountedOnce(buy, "BUY");
    expectCostsCountedOnce(sell, "SELL");
  });
});
