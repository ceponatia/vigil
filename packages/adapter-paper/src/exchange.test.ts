import { describe, expect, it } from "vitest";
import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";

import { createPaperExchange } from "./exchange";
import type {
  CancelOrderResult,
  PaperExchange,
  PaperExchangeConfig,
  PollOrderResult,
  ReconcileOrderResult,
  SubmitOrderResult,
  VenueOrderView,
  VenueReconciliationReport,
} from "./exchange";
import type { PaperRefusal } from "./diagnostics";
import { ACKNOWLEDGE_AND_REST } from "./faults";
import type { RestingBehavior, VenueBehavior } from "./faults";
import { CONFIRMED_VENUE_STATES, ORDER_STATES, ORDER_STATE_TRANSITIONS } from "./order-state";
import type { OrderState } from "./order-state";
import { settlementOf } from "./order";
import type { OrderSettlement, PaperOrder } from "./order";
import {
  AT_RESERVED,
  AT_SUBMITTED,
  SELL_INTENT,
  TEST_BASE_ASSET_ID,
  TEST_QUOTE_ASSET_ID,
  TEST_EXCHANGE_CONFIG,
  afterAcceptance,
  instant,
  rawQuote,
  reservedOrder,
} from "./test-support/order-fixtures";

const d = (value: string): DecimalString => decimalStringSchema.parse(value);

const CLIENT_ORDER_ID = "idem-0001";

/** The venue fee out of the cost breakdown; `execution-economics.test.ts` owns the rest of it. */
function venueFee(settlement: OrderSettlement): DecimalString {
  const fee = settlement.economics.costs.find((cost) => cost.component === "VENUE_FEE");
  if (fee === undefined) {
    throw new Error("the settlement reports no VENUE_FEE component at all");
  }
  return fee.amount;
}

/**
 * Every transition any test in this file actually drove. The final suite
 * below asserts it covers the whole lifecycle table, so an edge that stops
 * being exercised fails loudly instead of quietly losing its only test.
 */
const observedTransitions = new Set<string>();

function observe(order: PaperOrder): PaperOrder {
  for (const step of order.history) {
    observedTransitions.add(`${step.from}->${step.to}`);
  }
  return order;
}

type OutcomeLike = { readonly outcome: string; readonly refusal?: PaperRefusal };

function summarize(result: OutcomeLike): string {
  if (result.refusal === undefined) {
    return result.outcome;
  }
  return `${result.outcome} (${result.refusal.reason.source}/${result.refusal.reason.code}: ${result.refusal.detail})`;
}

function submitted(result: SubmitOrderResult, expected: "ACKNOWLEDGED" | "UNKNOWN" | "REJECTED" | "EXPIRED"): PaperOrder {
  if (result.outcome !== expected) {
    throw new Error(`expected a ${expected} submission, got ${summarize(result)}`);
  }
  return observe(result.order);
}

function submitRefusal(result: SubmitOrderResult): PaperRefusal {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected the submission to be refused, got ${summarize(result)}`);
  }
  return result.refusal;
}

function polled(result: PollOrderResult): PaperOrder {
  if (result.outcome === "REFUSED") {
    throw new Error(`expected the poll to succeed, got ${summarize(result)}`);
  }
  return observe(result.order);
}

function pollRefusal(result: PollOrderResult): PaperRefusal {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected the poll to be refused, got ${summarize(result)}`);
  }
  return result.refusal;
}

function cancelled(result: CancelOrderResult, expected: "CANCELED" | "UNKNOWN"): PaperOrder {
  if (result.outcome !== expected) {
    throw new Error(`expected a ${expected} cancellation, got ${summarize(result)}`);
  }
  return observe(result.order);
}

function cancelRefusal(result: CancelOrderResult): PaperRefusal {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected the cancellation to be refused, got ${summarize(result)}`);
  }
  return result.refusal;
}

function resolvedOrder(result: ReconcileOrderResult): PaperOrder {
  if (result.outcome !== "RESOLVED") {
    throw new Error(`expected reconciliation to resolve the order, got ${summarize(result)}`);
  }
  return observe(result.order);
}

function unresolved(result: ReconcileOrderResult): PaperRefusal {
  if (result.outcome !== "UNRESOLVED") {
    throw new Error(`expected reconciliation to leave the order unresolved, got ${summarize(result)}`);
  }
  observe(result.order);
  return result.refusal;
}

function exchangeWith(behavior?: VenueBehavior, overrides: Partial<PaperExchangeConfig> = {}): PaperExchange {
  const behaviors: Record<string, VenueBehavior> = behavior === undefined ? {} : { [CLIENT_ORDER_ID]: behavior };
  return createPaperExchange({ ...TEST_EXCHANGE_CONFIG, ...overrides, behaviors });
}

function submitDefault(exchange: PaperExchange, intentOverrides: Record<string, unknown> = {}, attempt = 1): SubmitOrderResult {
  return exchange.submitOrder({ order: reservedOrder(intentOverrides, attempt), quote: rawQuote(), now: AT_SUBMITTED });
}

describe("submission: what the venue confirms, and what it refuses before the venue sees anything", () => {
  it("acknowledges a reserved order and stamps the venue's own order id on it", () => {
    const exchange = exchangeWith();
    const order = submitted(submitDefault(exchange), "ACKNOWLEDGED");

    expect(order.state).toBe("ACKNOWLEDGED");
    expect(order.venueOrderId).toBe("PAPER-000001");
    expect(order.submittedAt).toBe(AT_SUBMITTED);
    expect(order.acknowledgedAt).toBe(AT_SUBMITTED);
    expect(order.history.map((step) => `${step.from}->${step.to}`)).toEqual([
      "PROPOSED->VALIDATED",
      "VALIDATED->RESERVED",
      "RESERVED->SUBMITTING",
      "SUBMITTING->ACKNOWLEDGED",
    ]);
  });

  it("refuses to submit anything that is not reserved — capital is reserved before dispatch", () => {
    const exchange = exchangeWith();
    const reserved = reservedOrder();
    const acknowledged = submitted(exchange.submitOrder({ order: reserved, quote: rawQuote(), now: AT_SUBMITTED }), "ACKNOWLEDGED");
    const refusal = submitRefusal(exchange.submitOrder({ order: acknowledged, quote: rawQuote(), now: AT_SUBMITTED }));
    expect(refusal.reason.code).toBe("ORDER_NOT_RESERVED");
  });

  it("refuses an intent whose validity window has already closed", () => {
    const exchange = exchangeWith();
    const refusal = submitRefusal(
      exchange.submitOrder({
        order: reservedOrder(),
        quote: rawQuote({ timestamps: { quoteAcquiredAt: "2024-01-01T00:10:30.000Z", ingestedAt: "2024-01-01T00:10:30.250Z" } }),
        now: instant("2024-01-01T00:10:31.000Z"),
      }),
    );
    expect(refusal.reason.code).toBe("INTENT_EXPIRED");
  });

  it("refuses a stale quote with the policy reason code, not an adapter diagnostic", () => {
    const exchange = exchangeWith();
    const refusal = submitRefusal(
      exchange.submitOrder({
        order: reservedOrder({ requiredFreshnessMs: 100 }),
        quote: rawQuote(),
        now: instant("2024-01-01T00:00:30.000Z"),
      }),
    );
    expect(refusal.reason).toEqual({ source: "policy", code: "STALE_QUOTE" });
  });

  it("refuses a buy whose worst case at the venue's capped price would breach maxSpend", () => {
    // The whole order at 250.10 costs 500.20 plus a 1.26 fee. One cent
    // under that is a refusal, not a smaller order: the adapter never
    // renegotiates an approved envelope.
    const exchange = exchangeWith();
    expect(submitRefusal(submitDefault(exchange, { maxSpend: "501.45" })).reason.code).toBe("MAX_SPEND_EXCEEDED");
    expect(submitted(submitDefault(exchange, { maxSpend: "501.46" }), "ACKNOWLEDGED").state).toBe("ACKNOWLEDGED");
  });

  it("refuses a sell whose worst case would pay less than the approved minimum receipt", () => {
    const exchange = exchangeWith();
    const sell = { ...SELL_INTENT, minAcceptableReceipt: "498.76" };
    expect(submitRefusal(submitDefault(exchange, sell)).reason.code).toBe("RECEIPT_BELOW_MINIMUM");
  });

  it("reaches REJECTED and EXPIRED only from a confirmation the venue gave", () => {
    const rejecting = exchangeWith({
      submission: { kind: "REJECT", detail: "venue rejected: instrument halted" },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
    });
    const rejected = submitted(submitDefault(rejecting), "REJECTED");
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.closedAt).toBe(AT_SUBMITTED);

    const expiring = exchangeWith({
      submission: { kind: "EXPIRE", detail: "venue expired: time in force elapsed before matching" },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
    });
    expect(submitted(submitDefault(expiring), "EXPIRED").state).toBe("EXPIRED");
  });

  it("applies the slippage cap against the caller, rounding the price up for a buy", () => {
    const exchange = createPaperExchange({ ...TEST_EXCHANGE_CONFIG, slippageBasisPoints: 100 });
    const order = polled(
      exchange.pollOrder({
        order: submitted(submitDefault(exchange), "ACKNOWLEDGED"),
        now: afterAcceptance(0),
      }),
    );
    // 250.10 + 1% = 252.601, rounded UP to the venue's cent: 252.61.
    expect(order.executions.map((execution) => execution.price)).toEqual(["252.61"]);
    expect(settlementOf(order).economics.netCashFlow).toBe("-506.49");
  });
});

describe("fills: exact arithmetic, nothing reported before it is due, identical for an identical seed", () => {
  it("fills the whole quantity in one execution with an exact notional and a fee rounded up", () => {
    const exchange = exchangeWith();
    const order = polled(exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(0) }));

    expect(order.state).toBe("FILLED");
    expect(order.executions).toHaveLength(1);
    expect(order.executions.map((execution) => [execution.quantity, execution.price, execution.notional, execution.fee])).toEqual([
      ["2.0000", "250.10", "500.20", "1.26"],
    ]);

    const settlement = settlementOf(order);
    expect(settlement.settled).toBe(true);
    expect(settlement.filledQuantity).toBe("2.0000");
    expect(settlement.economics.grossNotional).toBe("500.20");
    expect(venueFee(settlement)).toBe("1.26");
    expect(settlement.economics.netCashFlow).toBe("-501.46");
    expect(settlement.releasableRemainder).toBe("0.0000");
  });

  it("credits a sell, net of its fee, instead of debiting it", () => {
    const exchange = exchangeWith();
    const order = polled(
      exchange.pollOrder({
        order: submitted(submitDefault(exchange, SELL_INTENT), "ACKNOWLEDGED"),
        now: afterAcceptance(0),
      }),
    );
    const settlement = settlementOf(order);
    expect(settlement.economics.grossNotional).toBe("500.00");
    expect(venueFee(settlement)).toBe("1.25");
    expect(settlement.economics.netCashFlow).toBe("498.75");
    expect(settlement.economics.netProceeds).toBe("498.75");
  });

  it("walks ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED across two executions", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: {
        kind: "STEPS",
        steps: [
          { quantity: d("0.5000"), afterMs: 0 },
          { quantity: d("1.5000"), afterMs: 1_000 },
        ],
      },
      cancellation: { kind: "CONFIRM" },
    });

    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");
    const partial = polled(exchange.pollOrder({ order: acknowledged, now: afterAcceptance(0) }));
    expect(partial.state).toBe("PARTIALLY_FILLED");
    expect(settlementOf(partial).filledQuantity).toBe("0.5000");
    // Still working: a partially filled order that could yet fill releases
    // nothing at all.
    expect(settlementOf(partial).releasableRemainder).toBeNull();

    const filled = polled(exchange.pollOrder({ order: partial, now: afterAcceptance(1_000) }));
    expect(filled.state).toBe("FILLED");
    expect(filled.executions).toHaveLength(2);
    const settlement = settlementOf(filled);
    expect(settlement.filledQuantity).toBe("2.0000");
    // Identical to a single execution of the same quantity: totals are
    // computed on the cumulative fill, never summed from independent roundings.
    expect(settlement.economics.grossNotional).toBe("500.20");
    expect(venueFee(settlement)).toBe("1.26");
    expect(settlement.economics.netCapitalConsumed).toBe("501.46");
    expect(settlement.releasableRemainder).toBe("0.0000");
  });

  it("does not report an execution before the time it is scheduled for", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "FULL", afterMs: 5_000 },
      cancellation: { kind: "CONFIRM" },
    });
    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");

    const early = exchange.pollOrder({ order: acknowledged, now: afterAcceptance(4_999) });
    expect(early.outcome).toBe("UNCHANGED");
    expect(polled(early).executions).toHaveLength(0);

    expect(polled(exchange.pollOrder({ order: acknowledged, now: afterAcceptance(5_000) })).state).toBe("FILLED");
  });

  it("produces identical fills for the same seed and client order id, every run", () => {
    const seeded: VenueBehavior = {
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "SEEDED", stepCount: 3, intervalMs: 1_000 },
      cancellation: { kind: "CONFIRM" },
    };

    // Same reason as `accept` in exchange.ts: a closure bound to a `const`
    // rather than a hoisted declaration, so it keeps any narrowing in scope.
    const driveToFill = (): PaperOrder => {
      const exchange = exchangeWith(seeded);
      let order = submitted(submitDefault(exchange), "ACKNOWLEDGED");
      for (const offset of [1_000, 2_000, 3_000]) {
        order = polled(exchange.pollOrder({ order, now: afterAcceptance(offset) }));
      }
      return order;
    };

    const first = driveToFill();
    const second = driveToFill();

    expect(first.state).toBe("FILLED");
    expect(second.executions).toEqual(first.executions);
    // Pinned, not merely self-consistent. Calling one pure function twice
    // with the same arguments proves nothing about the split staying put: a
    // change to the hash constants or the weighting would silently reshape
    // every seeded fill in the repository and this assertion is what notices.
    expect(first.executions.map((execution) => execution.quantity)).toEqual(["0.7228", "0.8915", "0.3857"]);
    // Exact regardless of how the split fell: three partial quantities that
    // add up to the whole order, and totals identical to one execution of it.
    expect(settlementOf(first).filledQuantity).toBe("2.0000");
    expect(settlementOf(first).unfilledQuantity).toBe("0.0000");
    expect(settlementOf(first).economics.grossNotional).toBe("500.20");
    expect(venueFee(settlementOf(first))).toBe("1.26");
    expect(settlementOf(first).economics.netCapitalConsumed).toBe("501.46");
  });
});

describe("a submission timeout is UNKNOWN — never an assumed success and never an assumed failure", () => {
  const timedOutButAccepted: VenueBehavior = {
    submission: { kind: "TIMEOUT", venueAccepted: true },
    executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
    cancellation: { kind: "CONFIRM" },
  };

  it("leaves the order UNKNOWN, with no venue order id and no executions the caller never saw", () => {
    const exchange = exchangeWith(timedOutButAccepted);
    const order = submitted(submitDefault(exchange), "UNKNOWN");

    expect(order.state).toBe("UNKNOWN");
    expect(order.venueOrderId).toBeNull();
    expect(order.executions).toHaveLength(0);
    expect(order.closedAt).toBeNull();
  });

  it("releases nothing while the order is unresolved", () => {
    const exchange = exchangeWith(timedOutButAccepted);
    const settlement = settlementOf(submitted(submitDefault(exchange), "UNKNOWN"));
    expect(settlement.settled).toBe(false);
    expect(settlement.releasableRemainder).toBeNull();
  });

  it("refuses to poll or cancel an unresolved order — reconciliation comes first", () => {
    const exchange = exchangeWith(timedOutButAccepted);
    const order = submitted(submitDefault(exchange), "UNKNOWN");

    expect(pollRefusal(exchange.pollOrder({ order, now: afterAcceptance(1_000) })).reason.code).toBe("RECONCILIATION_REQUIRED");
    expect(cancelRefusal(exchange.cancelOrder({ order, now: afterAcceptance(1_000) })).reason.code).toBe("RECONCILIATION_REQUIRED");
  });

  it("refuses a blind resubmission while the venue is still working the order, and creates no second order", () => {
    const exchange = exchangeWith(timedOutButAccepted);
    submitted(submitDefault(exchange), "UNKNOWN");

    const retry = submitRefusal(submitDefault(exchange, {}, 2));
    expect(retry.reason).toEqual({
      source: "policy",
      code: "TRANSACTION_UNRESOLVED",
    });

    const report = exchange.readVenueState({ now: afterAcceptance(1_000) });
    expect([...report.openOrders, ...report.closedOrders]).toHaveLength(1);
  });

  it("refuses a resubmission once the venue has closed the order under that idempotency key", () => {
    const exchange = exchangeWith({
      submission: { kind: "TIMEOUT", venueAccepted: true },
      executions: { kind: "FULL", afterMs: 0 },
      cancellation: { kind: "CONFIRM" },
    });
    submitted(submitDefault(exchange), "UNKNOWN");
    expect(submitRefusal(submitDefault(exchange, {}, 2)).reason.code).toBe("IDEMPOTENCY_KEY_ALREADY_USED");
  });
});

describe("reconciliation is the only thing that resolves an unresolved order", () => {
  const scenarios: ReadonlyArray<{ readonly expected: OrderState; readonly behavior: VenueBehavior }> = [
    {
      expected: "ACKNOWLEDGED",
      behavior: { submission: { kind: "TIMEOUT", venueAccepted: true }, executions: { kind: "NONE" }, cancellation: { kind: "CONFIRM" } },
    },
    {
      expected: "PARTIALLY_FILLED",
      behavior: {
        submission: { kind: "TIMEOUT", venueAccepted: true },
        executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
        cancellation: { kind: "CONFIRM" },
      },
    },
    {
      expected: "FILLED",
      behavior: { submission: { kind: "TIMEOUT", venueAccepted: true }, executions: { kind: "FULL", afterMs: 0 }, cancellation: { kind: "CONFIRM" } },
    },
    {
      expected: "CANCELED",
      behavior: {
        submission: { kind: "TIMEOUT", venueAccepted: true },
        executions: { kind: "NONE" },
        cancellation: { kind: "CONFIRM" },
        resting: { kind: "CANCEL", afterMs: 0, detail: "venue cancelled the resting order on session loss" },
      },
    },
    {
      expected: "EXPIRED",
      behavior: {
        submission: { kind: "TIMEOUT", venueAccepted: true },
        executions: { kind: "NONE" },
        cancellation: { kind: "CONFIRM" },
        resting: { kind: "EXPIRE", afterMs: 0, detail: "venue expired the resting order" },
      },
    },
    {
      // Nothing was ever accepted. An authoritative read that holds no
      // record of it is a confirmation of non-acceptance, which is the only
      // way this adapter reaches REJECTED without the venue saying the word.
      expected: "REJECTED",
      behavior: { submission: { kind: "TIMEOUT", venueAccepted: false }, executions: { kind: "NONE" }, cancellation: { kind: "CONFIRM" } },
    },
  ];

  for (const scenario of scenarios) {
    it(`resolves an UNKNOWN order to ${scenario.expected} when that is what the venue confirms`, () => {
      const exchange = exchangeWith(scenario.behavior);
      const unknownOrder = submitted(submitDefault(exchange), "UNKNOWN");
      const now = afterAcceptance(5_000);
      const resolved = resolvedOrder(
        exchange.reconcileOrder({ order: unknownOrder, report: exchange.readVenueState({ now }), now }),
      );
      expect(resolved.state).toBe(scenario.expected);
    });
  }

  it("covers every state the lifecycle allows reconciliation to resolve to", () => {
    expect(scenarios.map((scenario) => scenario.expected).sort()).toEqual([...CONFIRMED_VENUE_STATES].sort());
  });

  it("resolves nothing from a read that could not see the whole venue", () => {
    const exchange = exchangeWith(
      { submission: { kind: "TIMEOUT", venueAccepted: false }, executions: { kind: "NONE" }, cancellation: { kind: "CONFIRM" } },
      { reconciliationCoverage: "INCOMPLETE" },
    );
    const order = submitted(submitDefault(exchange), "UNKNOWN");
    const now = afterAcceptance(5_000);
    const report = exchange.readVenueState({ now });
    expect(report.coverage).toBe("INCOMPLETE");

    const result = exchange.reconcileOrder({ order, report, now });
    expect(unresolved(result).reason.code).toBe("RECONCILIATION_INCOMPLETE");
    if (result.outcome === "UNRESOLVED") {
      // Absence proves nothing when the read was partial: the order is
      // still UNKNOWN, and still releases nothing.
      expect(result.order.state).toBe("UNKNOWN");
      expect(settlementOf(result.order).releasableRemainder).toBeNull();
    }
  });

  it("recovers the crash-shaped gap: the venue accepted, the caller never heard, and there is still one order", () => {
    const exchange = exchangeWith({
      submission: { kind: "TIMEOUT", venueAccepted: true },
      executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
      cancellation: { kind: "CONFIRM" },
    });
    const order = submitted(submitDefault(exchange), "UNKNOWN");
    const now = afterAcceptance(2_000);
    const report = exchange.readVenueState({ now });

    expect(report.openOrders).toHaveLength(1);
    expect(report.openOrders.map((view) => [view.state, view.filledQuantity, view.unfilledQuantity])).toEqual([
      ["PARTIALLY_FILLED", "0.5000", "1.5000"],
    ]);
    expect(report.executions).toHaveLength(1);

    const resolved = resolvedOrder(exchange.reconcileOrder({ order, report, now }));
    expect(resolved.state).toBe("PARTIALLY_FILLED");
    expect(resolved.venueOrderId).toBe("PAPER-000001");
    expect(settlementOf(resolved).filledQuantity).toBe("0.5000");
  });

  it("refuses to reconcile an order that is not waiting on the venue", () => {
    const exchange = exchangeWith();
    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");
    const now = afterAcceptance(0);
    const result = exchange.reconcileOrder({ order: acknowledged, report: exchange.readVenueState({ now }), now });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") {
      expect(result.refusal.reason.code).toBe("RECONCILIATION_NOT_APPLICABLE");
    }
  });
});

describe("cancellation: filled exposure persists, only the confirmed remainder is released", () => {
  it("cancels a resting order through CANCEL_PENDING and releases the whole quantity", () => {
    const exchange = exchangeWith(ACKNOWLEDGE_AND_REST);
    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");
    const canceled = cancelled(exchange.cancelOrder({ order: acknowledged, now: afterAcceptance(1_000) }), "CANCELED");

    expect(canceled.history.map((step) => `${step.from}->${step.to}`).slice(-2)).toEqual([
      "ACKNOWLEDGED->CANCEL_PENDING",
      "CANCEL_PENDING->CANCELED",
    ]);
    const settlement = settlementOf(canceled);
    expect(settlement.filledQuantity).toBe("0.0000");
    expect(settlement.releasableRemainder).toBe("2.0000");
  });

  it("keeps a partial fill and its fee after a cancellation, releasing only the unfilled remainder", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: {
        kind: "STEPS",
        steps: [
          { quantity: d("0.5000"), afterMs: 0 },
          { quantity: d("1.5000"), afterMs: 10_000 },
        ],
      },
      cancellation: { kind: "CONFIRM" },
    });

    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");
    const partial = polled(exchange.pollOrder({ order: acknowledged, now: afterAcceptance(0) }));
    expect(partial.state).toBe("PARTIALLY_FILLED");

    const canceled = cancelled(exchange.cancelOrder({ order: partial, now: afterAcceptance(1_000) }), "CANCELED");
    expect(canceled.state).toBe("CANCELED");
    expect(canceled.history.map((step) => `${step.from}->${step.to}`).slice(-2)).toEqual([
      "PARTIALLY_FILLED->CANCEL_PENDING",
      "CANCEL_PENDING->CANCELED",
    ]);

    const settlement = settlementOf(canceled);
    // The exposure and the fee the venue already charged survive the
    // cancellation; only the 1.5000 that never executed comes back.
    expect(settlement.filledQuantity).toBe("0.5000");
    expect(settlement.economics.grossNotional).toBe("125.05");
    expect(venueFee(settlement)).toBe("0.32");
    expect(settlement.economics.netCashFlow).toBe("-125.37");
    expect(settlement.releasableRemainder).toBe("1.5000");
    // 1.5000 is far more than the intent's permitted residual of 0.0100, so
    // the caller is told rather than left to assume it was dust.
    expect(settlement.residualExceedsPermitted).toBe(true);

    // The scheduled second execution is gone: a canceled order does not
    // keep filling.
    const report = exchange.readVenueState({ now: afterAcceptance(60_000) });
    expect(report.executions).toHaveLength(1);
    expect(report.closedOrders.map((view) => view.state)).toEqual(["CANCELED"]);
  });

  it("treats a lost cancellation confirmation as unresolved, and reconciliation settles it", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "NONE" },
      cancellation: { kind: "TIMEOUT" },
    });
    const acknowledged = submitted(submitDefault(exchange), "ACKNOWLEDGED");
    const pending = cancelled(exchange.cancelOrder({ order: acknowledged, now: afterAcceptance(1_000) }), "UNKNOWN");

    expect(pending.state).toBe("CANCEL_PENDING");
    // Nothing is released on an unconfirmed cancellation — not even the
    // quantity that obviously never filled.
    expect(settlementOf(pending).releasableRemainder).toBeNull();

    const now = afterAcceptance(2_000);
    const resolved = resolvedOrder(exchange.reconcileOrder({ order: pending, report: exchange.readVenueState({ now }), now }));
    expect(resolved.state).toBe("CANCELED");
    expect(settlementOf(resolved).releasableRemainder).toBe("2.0000");
  });

  it("refuses to cancel an order the venue has already closed", () => {
    const exchange = exchangeWith();
    const filled = polled(exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(0) }));
    expect(filled.state).toBe("FILLED");
    expect(cancelRefusal(exchange.cancelOrder({ order: filled, now: afterAcceptance(1_000) })).reason.code).toBe("ORDER_ALREADY_TERMINAL");
  });
});

describe("the venue's own terminal events on a resting order", () => {
  it("expires a resting order the caller is still watching", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
      resting: { kind: "EXPIRE", afterMs: 1_000, detail: "time in force elapsed" },
    });
    const order = polled(exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(1_000) }));
    expect(order.state).toBe("EXPIRED");
    expect(settlementOf(order).releasableRemainder).toBe("2.0000");
  });

  it("rejects an order it had already acknowledged", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
      resting: { kind: "REJECT", afterMs: 1_000, detail: "venue withdrew the acknowledgement" },
    });
    const order = polled(exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(1_000) }));
    expect(order.state).toBe("REJECTED");
  });
});

describe("a fill stays traceable to the approval that authorized it", () => {
  it("carries its own identity and provenance into the flattened reconciliation read", () => {
    const exchange = exchangeWith();
    const order = polled(
      exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(0) }),
    );
    const report = exchange.readVenueState({ now: afterAcceptance(0) });

    // `report.executions` flattens fills from every order together, so an
    // execution read out of it has no parent record to inherit from. If the
    // execution does not carry its own identity, a persisted or replayed fill
    // cannot be tied back to the approval that authorized it at all.
    expect(report.executions).toHaveLength(1);
    const execution = report.executions[0];
    expect(execution?.clientOrderId).toBe(CLIENT_ORDER_ID);
    expect(execution?.venueOrderId).toBe(order.venueOrderId);
    expect(execution?.provenance).toEqual(order.provenance);
    expect(execution?.provenance.correlationId).toBe("corr-0001");
    expect(execution?.provenance.intentId).toBe("intent-0001");
    expect(execution?.provenance.modelVersion).toBeNull();
  });
});

describe("the capability stamp", () => {
  it("declares PAPER, no live endpoint, no credential, and no signing", () => {
    const capability = exchangeWith().capability;
    expect(capability.mode).toBe("PAPER");
    expect(capability.reachesLiveEndpoint).toBe(false);
    expect(capability.holdsVenueCredential).toBe(false);
    expect(capability.canSignTransactions).toBe(false);
    expect(capability.supportedOrderStates).toEqual(ORDER_STATES);
  });
});

describe("a venue-initiated cancellation never wedges the order the caller is watching", () => {
  // The defect: the venue takes a resting order ACKNOWLEDGED ->
  // CANCEL_PENDING -> CANCELED in one step, and a caller offered only the
  // direct ACKNOWLEDGED -> CANCELED jump is refused, because the lifecycle
  // does not draw it. Before the caller was walked through the documented
  // route, that order could never be advanced by anything: poll refused,
  // cancel refused, reconcile refused, its reserved capital was never
  // released, and any fill it held was permanently invisible.
  const venueCancels = (afterMs: number): RestingBehavior => ({
    kind: "CANCEL",
    afterMs,
    detail: "venue cancelled the resting order on session loss",
  });

  it("walks an acknowledged order through CANCEL_PENDING when the venue cancels it unprompted", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
      resting: venueCancels(1_000),
    });
    const order = polled(
      exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(1_000) }),
    );

    expect(order.state).toBe("CANCELED");
    expect(order.history.map((step) => `${step.from}->${step.to}`).slice(-2)).toEqual([
      "ACKNOWLEDGED->CANCEL_PENDING",
      "CANCEL_PENDING->CANCELED",
    ]);
    expect(settlementOf(order).releasableRemainder).toBe("2.0000");
  });

  it("keeps a partial fill visible, and in the history, when the venue cancels the remainder", () => {
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
      cancellation: { kind: "CONFIRM" },
      resting: venueCancels(1_000),
    });
    const order = polled(
      exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(1_000) }),
    );

    expect(order.state).toBe("CANCELED");
    // The order genuinely held exposure before it was cancelled, and the
    // history says so rather than jumping straight to the terminal state.
    expect(order.history.map((step) => `${step.from}->${step.to}`).slice(-3)).toEqual([
      "ACKNOWLEDGED->PARTIALLY_FILLED",
      "PARTIALLY_FILLED->CANCEL_PENDING",
      "CANCEL_PENDING->CANCELED",
    ]);
    expect(order.executions).toHaveLength(1);
    const settlement = settlementOf(order);
    expect(settlement.filledQuantity).toBe("0.5000");
    expect(settlement.releasableRemainder).toBe("1.5000");
    expect(venueFee(settlement)).toBe("0.32");
  });
});

describe("the quote has to be a quote for this order", () => {
  it("refuses a quote that prices a different instrument", () => {
    // Freshness and schema say the quote is well-formed and current; neither
    // says it prices these assets. Without the identity check an order for
    // (A, B) fills at an unrelated instrument's price and passes its own
    // envelope check against it.
    const exchange = exchangeWith();
    const refusal = submitRefusal(
      exchange.submitOrder({
        order: reservedOrder(),
        quote: rawQuote({ instrumentId: `${TEST_QUOTE_ASSET_ID}/${TEST_BASE_ASSET_ID}` }),
        now: AT_SUBMITTED,
      }),
    );
    expect(refusal.reason.code).toBe("QUOTE_INSTRUMENT_MISMATCH");
  });

  it("refuses a crossed book rather than pricing from corrupt market state", () => {
    const exchange = exchangeWith();
    const refusal = submitRefusal(
      exchange.submitOrder({
        order: reservedOrder(),
        quote: rawQuote({ bidPrice: "250.10", askPrice: "250.00" }),
        now: AT_SUBMITTED,
      }),
    );
    expect(refusal.reason.code).toBe("CROSSED_QUOTE_BOOK");
  });
});

describe("only a reconciliation read this exchange issued resolves anything", () => {
  it("refuses a hand-built report, so a fabricated fill cannot come in through the front door", () => {
    const exchange = exchangeWith({
      submission: { kind: "TIMEOUT", venueAccepted: false },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
    });
    const order = submitted(submitDefault(exchange), "UNKNOWN");
    const now = afterAcceptance(1_000);
    const real = exchange.readVenueState({ now });

    const forgedView: VenueOrderView = {
      venueOrderId: "PAPER-999999",
      clientOrderId: CLIENT_ORDER_ID,
      side: "BUY",
      state: "FILLED",
      quantity: d("2.0000"),
      filledQuantity: d("2.0000"),
      unfilledQuantity: d("0.0000"),
      grossNotional: d("500.20"),
      feesPaid: d("1.26"),
      acceptedAt: AT_SUBMITTED,
      closedAt: AT_SUBMITTED,
      executions: [],
      droppedVenueEvents: [],
    };
    // A faithful copy of a real report with one row added — everything the
    // type demands, and not the object this exchange issued.
    const forged: VenueReconciliationReport = { ...real, closedOrders: [forgedView] };

    const refused = exchange.reconcileOrder({ order, report: forged, now });
    expect(refused.outcome).toBe("REFUSED");
    if (refused.outcome === "REFUSED") {
      expect(refused.refusal.reason.code).toBe("RECONCILIATION_REPORT_UNRECOGNIZED");
    }

    // The genuine read says what actually happened: nothing.
    const resolved = exchange.reconcileOrder({ order, report: real, now });
    expect(resolved.outcome).toBe("RESOLVED");
    if (resolved.outcome === "RESOLVED") {
      expect(resolved.order.state).toBe("REJECTED");
      expect(resolved.order.executions).toHaveLength(0);
    }
  });
});

describe("an intent already dispatched is not dispatched again without reconciliation", () => {
  const neverAccepted: VenueBehavior = {
    submission: { kind: "TIMEOUT", venueAccepted: false },
    executions: { kind: "NONE" },
    cancellation: { kind: "CONFIRM" },
  };

  it("refuses a second dispatch even when the venue accepted nothing and holds no record", () => {
    // The order book cannot be the only guard: this submission left no book
    // entry, and `PaperOrder` is immutable, so the caller still holds its
    // untouched RESERVED order and could simply submit it again.
    const exchange = exchangeWith(neverAccepted);
    submitted(submitDefault(exchange), "UNKNOWN");

    const retry = submitRefusal(submitDefault(exchange, {}, 2));
    expect(retry.reason).toEqual({ source: "policy", code: "TRANSACTION_UNRESOLVED" });
    expect(exchange.readVenueState({ now: afterAcceptance(1_000) }).openOrders).toHaveLength(0);
  });

  it("answers that retry with TRANSACTION_UNRESOLVED rather than a stale quote", () => {
    // Both refuse, but they tell the caller to do opposite things: "refresh
    // your quote and try again" is exactly the blind retry the other answer
    // exists to prevent.
    const exchange = exchangeWith(neverAccepted);
    submitted(submitDefault(exchange), "UNKNOWN");

    const retry = submitRefusal(
      exchange.submitOrder({
        order: reservedOrder({}, 2),
        quote: rawQuote(),
        now: instant("2024-01-01T00:02:00.000Z"),
      }),
    );
    expect(retry.reason.code).toBe("TRANSACTION_UNRESOLVED");
  });

  it("refuses a read taken before the dispatch it is asked to resolve, and keeps the guard up", () => {
    // The read is entirely genuine — it came from `readVenueState` and was
    // not edited — and it is still worthless here, because it was taken
    // before this order was ever dispatched. Its authoritative absence of the
    // order means "not dispatched yet", never "the venue did not accept it".
    // Accepting it would satisfy "reconciliation precedes resubmission" with
    // a read that predates the dispatch and let the retry through blind.
    const exchange = exchangeWith(neverAccepted);
    const beforeDispatch = exchange.readVenueState({ now: AT_RESERVED });
    const order = submitted(submitDefault(exchange), "UNKNOWN");

    const refused = exchange.reconcileOrder({ order, report: beforeDispatch, now: afterAcceptance(1_000) });
    expect(refused.outcome).toBe("REFUSED");
    if (refused.outcome === "REFUSED") {
      expect(refused.refusal.reason.code).toBe("RECONCILIATION_READ_PREDATES_DISPATCH");
    }

    // The guard is still up: the stale read lifted nothing.
    expect(submitRefusal(submitDefault(exchange, {}, 2)).reason.code).toBe("TRANSACTION_UNRESOLVED");
  });

  it("lifts the guard once an authoritative read confirms the venue holds nothing", () => {
    const exchange = exchangeWith(neverAccepted);
    const order = submitted(submitDefault(exchange), "UNKNOWN");
    const now = afterAcceptance(1_000);

    const resolved = exchange.reconcileOrder({ order, report: exchange.readVenueState({ now }), now });
    expect(resolved.outcome).toBe("RESOLVED");
    if (resolved.outcome === "RESOLVED") {
      expect(resolved.resolution).toBe("VENUE_HELD_NO_RECORD");
    }

    // Reconciliation preceded resubmission, so a fresh versioned attempt is
    // dispatched rather than refused.
    expect(submitDefault(exchange, {}, 3).outcome).toBe("UNKNOWN");
  });
});

describe("reconciliation reports the basis it resolved on, not only the state", () => {
  it("distinguishes a venue that confirmed an outcome from a venue that held no record", () => {
    // Both can end at REJECTED and they are different facts: a confirmed
    // rejection may be durable, while an order the venue never received is
    // safe to dispatch again once the intent is re-validated. Code has to be
    // able to switch on that, so it cannot live only in a note.
    const accepted = exchangeWith({
      submission: { kind: "TIMEOUT", venueAccepted: true },
      executions: { kind: "FULL", afterMs: 0 },
      cancellation: { kind: "CONFIRM" },
    });
    const acceptedOrder = submitted(submitDefault(accepted), "UNKNOWN");
    const acceptedAt = afterAcceptance(1_000);
    const confirmed = accepted.reconcileOrder({
      order: acceptedOrder,
      report: accepted.readVenueState({ now: acceptedAt }),
      now: acceptedAt,
    });
    expect(confirmed.outcome).toBe("RESOLVED");
    if (confirmed.outcome === "RESOLVED") {
      expect(confirmed.resolution).toBe("VENUE_CONFIRMED");
      expect(observe(confirmed.order).state).toBe("FILLED");
    }

    const lost = exchangeWith({
      submission: { kind: "TIMEOUT", venueAccepted: false },
      executions: { kind: "NONE" },
      cancellation: { kind: "CONFIRM" },
    });
    const lostOrder = submitted(submitDefault(lost), "UNKNOWN");
    const lostAt = afterAcceptance(1_000);
    const absent = lost.reconcileOrder({
      order: lostOrder,
      report: lost.readVenueState({ now: lostAt }),
      now: lostAt,
    });
    expect(absent.outcome).toBe("RESOLVED");
    if (absent.outcome === "RESOLVED") {
      expect(absent.resolution).toBe("VENUE_HELD_NO_RECORD");
      expect(observe(absent.order).state).toBe("REJECTED");
    }
  });
});

describe("a venue event the lifecycle cannot express is reported, not dropped in silence", () => {
  it("records an expiry that arrived after the order had already filled something", () => {
    // The lifecycle draws no PARTIALLY_FILLED -> EXPIRED edge, so the event
    // cannot be applied. A scenario that scheduled it would otherwise pass
    // while having simulated nothing at all.
    const exchange = exchangeWith({
      submission: { kind: "ACKNOWLEDGE" },
      executions: { kind: "STEPS", steps: [{ quantity: d("0.5000"), afterMs: 0 }] },
      cancellation: { kind: "CONFIRM" },
      resting: { kind: "EXPIRE", afterMs: 1_000, detail: "time in force elapsed" },
    });
    const order = polled(
      exchange.pollOrder({ order: submitted(submitDefault(exchange), "ACKNOWLEDGED"), now: afterAcceptance(1_000) }),
    );

    expect(order.state).toBe("PARTIALLY_FILLED");
    const report = exchange.readVenueState({ now: afterAcceptance(2_000) });
    const dropped = report.openOrders.flatMap((view) => view.droppedVenueEvents);
    expect(dropped).toHaveLength(1);
    expect(dropped.join(" ")).toContain("EXPIRE");
  });
});

describe("the lifecycle as a whole", () => {
  it("exercises every transition the Exchange lifecycle draws, and none it does not", () => {
    const expected = new Set<string>();
    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATE_TRANSITIONS[from]) {
        expected.add(`${from}->${to}`);
      }
    }

    // Only the forward direction earns its place. The reverse — that nothing
    // observed is outside the table — is vacuous here, because every entry in
    // `observedTransitions` came from an order's history and
    // `applyOrderTransition` already refuses anything the table does not draw.
    expect([...expected].filter((edge) => !observedTransitions.has(edge)).sort()).toEqual([]);
  });
});
