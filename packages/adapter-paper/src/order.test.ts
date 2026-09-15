import { describe, expect, it } from "vitest";

import { PAPER_ADAPTER_CAPABILITY_VERSION } from "./capability";
import { ACTION_ORDER_SIDES, TRADE_ACTIONS } from "./intent";
import { proposeOrder, reserveOrder, settlementOf, validateOrder } from "./order";
import type { PaperOrder, ProposeOrderResult } from "./order";
import { AT_PROPOSED, AT_RESERVED, AT_VALIDATED, rawIntent, reservedOrder } from "./test-support/order-fixtures";

function accepted(result: ProposeOrderResult): PaperOrder {
  if (!result.accepted) {
    throw new Error(`expected the intent to be accepted, but it was refused: ${result.refusal.reason.code} — ${result.refusal.detail}`);
  }
  return result.order;
}

function refusalCode(result: ProposeOrderResult): string {
  if (result.accepted) {
    throw new Error(`expected a refusal, but the intent was accepted into order ${result.order.clientOrderId}`);
  }
  return result.refusal.reason.code;
}

function propose(overrides: Record<string, unknown> = {}): ProposeOrderResult {
  return proposeOrder({ intent: rawIntent(overrides), at: AT_PROPOSED });
}

/** A well-formed intent with one field removed entirely, rather than nulled. */
function withoutField(field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rawIntent()).filter(([key]) => key !== field));
}

/**
 * The defect this file kills: an adapter that takes whatever it is handed.
 * A ticker instead of a chain-aware asset id, an action that authorized no
 * execution at all, a quantity of zero, or an intent approved against a
 * different adapter capability are each a way for an order to exist that
 * nothing ever actually authorized — and every one of them is silent if the
 * adapter simply builds the order it was asked for.
 */
describe("proposeOrder refuses rather than building an order nothing authorized", () => {
  it("refuses an intent that does not parse, naming the offending fields", () => {
    expect(refusalCode(propose({ quantity: "two point zero" }))).toBe("MALFORMED_INTENT");
    expect(refusalCode(proposeOrder({ intent: { nothing: "useful" }, at: AT_PROPOSED }))).toBe("MALFORMED_INTENT");
  });

  it("refuses a ticker where a canonical asset identity belongs", () => {
    // A symbol is display metadata, never identity: two assets that would
    // display "BTC" on different chains are different assets.
    expect(refusalCode(propose({ inputAssetId: "BTC" }))).toBe("MALFORMED_INTENT");
  });

  it("refuses an intent approved against a different adapter capability version", () => {
    expect(refusalCode(propose({ adapterCapabilityVersion: "paper-exchange-0" }))).toBe("CAPABILITY_VERSION_MISMATCH");
  });

  it("refuses a non-positive quantity", () => {
    expect(refusalCode(propose({ quantity: "0" }))).toBe("NON_POSITIVE_QUANTITY");
    expect(refusalCode(propose({ quantity: "0.0000" }))).toBe("NON_POSITIVE_QUANTITY");
    expect(refusalCode(propose({ quantity: "-1.0000" }))).toBe("NON_POSITIVE_QUANTITY");
  });

  it("refuses an amount carrying more precision than the arithmetic holds, rather than throwing", () => {
    // `decimalStringSchema` bounds neither precision nor scale, so these are
    // schema-legal values. Before the gate they reached `compareDecimals`,
    // whose internal scale guard threw — out of a function documented never
    // to throw on any input.
    const tooPrecise = `0.${"0".repeat(30)}1`;
    expect(refusalCode(propose({ quantity: tooPrecise }))).toBe("VENUE_PRECISION_EXCEEDED");
    expect(refusalCode(propose({ maxSpend: tooPrecise }))).toBe("VENUE_PRECISION_EXCEEDED");
    expect(refusalCode(propose({ minAcceptableReceipt: tooPrecise }))).toBe("VENUE_PRECISION_EXCEEDED");
    expect(refusalCode(propose({ permittedResidual: tooPrecise }))).toBe("VENUE_PRECISION_EXCEEDED");
  });

  it("refuses an attempt number that is not a positive integer", () => {
    expect(refusalCode(proposeOrder({ intent: rawIntent(), at: AT_PROPOSED, attempt: 0 }))).toBe("MALFORMED_INTENT");
  });
});

describe("an approved action decides the side, and a decision to do nothing never becomes an order", () => {
  // Derived from the registry rather than a copied case list: a new action
  // added to ACTION_ORDER_SIDES is covered here the moment it lands.
  for (const action of TRADE_ACTIONS) {
    const side = ACTION_ORDER_SIDES[action];
    if (side === null) {
      it(`refuses ${action}, which authorizes no execution`, () => {
        expect(refusalCode(propose({ action }))).toBe("NON_EXECUTABLE_ACTION");
      });
    } else {
      it(`opens a ${side} order for ${action}`, () => {
        expect(accepted(propose({ action })).side).toBe(side);
      });
    }
  }
});

describe("the caller's own three steps are guarded like every other transition", () => {
  it("records PROPOSED -> VALIDATED -> RESERVED with the times the caller supplied", () => {
    const order = reservedOrder();
    expect(order.state).toBe("RESERVED");
    expect(order.history.map((step) => `${step.from}->${step.to}`)).toEqual(["PROPOSED->VALIDATED", "VALIDATED->RESERVED"]);
    expect(order.history.map((step) => step.at)).toEqual([AT_VALIDATED, AT_RESERVED]);
  });

  it("refuses to reserve an order that was never validated", () => {
    const proposed = accepted(propose());
    const reserved = reserveOrder(proposed, AT_RESERVED);
    expect(reserved.applied).toBe(false);
    if (!reserved.applied) {
      expect(reserved.refusal.reason.code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("refuses to validate the same order twice", () => {
    const validated = validateOrder(accepted(propose()), AT_VALIDATED);
    expect(validated.applied).toBe(true);
    if (validated.applied) {
      const again = validateOrder(validated.order, AT_RESERVED);
      expect(again.applied).toBe(false);
    }
  });

  it("keeps the model and portfolio snapshot that authorized the order", () => {
    // AGENTS.md: every economic record carries the policy, strategy, model
    // and snapshot versions that produced it. Stripping two of them at the
    // schema meant every order and every fill this adapter produced had lost
    // which model and which portfolio snapshot stood behind it.
    expect(accepted(propose({ modelVersion: "model-0007" })).provenance.modelVersion).toBe("model-0007");
    expect(accepted(propose()).provenance.portfolioSnapshotVersion).toBe("portfolio-0001");
    // Nullable, not optional: "no LLM was involved" is a fact the record
    // states, so an intent that omits the field altogether is malformed.
    expect(refusalCode(proposeOrder({ intent: withoutField("modelVersion"), at: AT_PROPOSED }))).toBe("MALFORMED_INTENT");
    expect(refusalCode(proposeOrder({ intent: withoutField("portfolioSnapshotVersion"), at: AT_PROPOSED }))).toBe(
      "MALFORMED_INTENT",
    );
  });

  it("carries the intent's provenance and envelope onto the order unchanged", () => {
    const order = reservedOrder();
    expect(order.provenance).toEqual({
      intentId: "intent-0001",
      economicActionId: "action-0001",
      positionPlanId: "plan-0001",
      correlationId: "corr-0001",
      policyVersion: "policy-0001",
      strategyVersion: "strategy-0001",
      modelVersion: null,
      portfolioSnapshotVersion: "portfolio-0001",
      marketSnapshotVersion: "market-0001",
      feeSnapshotVersion: "fee-0001",
    });
    expect(order.envelope.maxSpend).toBe("510.00");
    // Carried through in the asset it was approved in. `maxSpend` and
    // `permittedResidual` are both INPUT-asset amounts, so this order's
    // residual is one unit of the quote asset and not 1.00 of the base asset
    // it is buying.
    expect(order.envelope.permittedResidual).toBe("1.00");
    expect(order.capabilityVersion).toBe(PAPER_ADAPTER_CAPABILITY_VERSION);
    expect(order.clientOrderId).toBe("idem-0001");
    expect(order.venueOrderId).toBeNull();
    expect(order.attempt).toBe(1);
  });
});

describe("settlementOf releases nothing until the venue has settled the order", () => {
  it("reports a reserved order as unsettled, with no releasable remainder", () => {
    const settlement = settlementOf(reservedOrder());
    expect(settlement.settled).toBe(false);
    // null, not "2.0000": nothing is released on the strength of an order
    // the venue has not answered for.
    expect(settlement.releasableRemainder).toBeNull();
    // Null for the same reason and in the same states: the 510.00 this order
    // holds is not "unspent" while the order could still spend it.
    expect(settlement.unspentInput).toBeNull();
    expect(settlement.filledQuantity).toBe("0.0000");
    expect(settlement.unfilledQuantity).toBe("2.0000");
    expect(settlement.residualExceedsPermitted).toBe(false);
    // No pricing yet, so no economics to state — zeros and nulls, not a guess
    // at what the order might have cost.
    expect(settlement.economics.grossNotional).toBe("0");
    expect(settlement.economics.totalIncrementalCost).toBe("0");
    expect(settlement.economics.netCashFlow).toBe("0");
    expect(settlement.economics.referenceBid).toBeNull();
    expect(settlement.economics.executionPrice).toBeNull();
    expect(settlement.economics.costs).toEqual([]);
  });
});
