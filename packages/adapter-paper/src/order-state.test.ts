import { describe, expect, it } from "vitest";

import {
  CONFIRMED_VENUE_STATES,
  LIVE_ORDER_STATES,
  ORDER_STATES,
  ORDER_STATE_TRANSITIONS,
  TERMINAL_ORDER_STATES,
  isLegalOrderTransition,
  isLiveOrderState,
  isTerminalOrderState,
} from "./order-state";
import type { OrderState } from "./order-state";

/**
 * The defect this file kills: a transition table that has quietly drifted
 * from `docs/architecture.md`'s Exchange diagram. Every other suite in this
 * package proves behavior AGAINST this table, so if the table is wrong they
 * all pass while simulating the wrong machine — and a machine with, say, a
 * `CANCEL_PENDING -> FILLED` edge would let an adapter report exposure the
 * ledger had already released.
 *
 * The literal below is therefore pinned by hand rather than derived: the
 * diagram IS the contract here, and a derived expectation would only prove
 * the table equals itself.
 */
describe("ORDER_STATE_TRANSITIONS transcribes the Exchange lifecycle diagram", () => {
  it("matches docs/architecture.md edge for edge", () => {
    expect(ORDER_STATE_TRANSITIONS).toEqual({
      PROPOSED: ["VALIDATED"],
      VALIDATED: ["RESERVED"],
      RESERVED: ["SUBMITTING"],
      SUBMITTING: ["ACKNOWLEDGED", "UNKNOWN", "REJECTED", "EXPIRED"],
      ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "REJECTED", "EXPIRED"],
      UNKNOWN: ["ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXPIRED"],
      PARTIALLY_FILLED: ["FILLED", "CANCEL_PENDING"],
      CANCEL_PENDING: ["CANCELED"],
      FILLED: [],
      CANCELED: [],
      REJECTED: [],
      EXPIRED: [],
    });
  });

  it("names every state in the registry and no others", () => {
    expect(Object.keys(ORDER_STATE_TRANSITIONS).sort()).toEqual([...ORDER_STATES].sort());
  });

  it("leaves every state reachable from PROPOSED", () => {
    const seen = new Set<OrderState>(["PROPOSED"]);
    const queue: OrderState[] = ["PROPOSED"];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const next of ORDER_STATE_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...ORDER_STATES].filter((state) => !seen.has(state))).toEqual([]);
  });
});

describe("isLegalOrderTransition refuses everything the diagram does not draw", () => {
  it("agrees with the table for every ordered pair of states", () => {
    const disagreements: string[] = [];
    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATES) {
        const tabled = from !== to && ORDER_STATE_TRANSITIONS[from].includes(to);
        if (isLegalOrderTransition(from, to) !== tabled) {
          disagreements.push(`${from}->${to}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("never treats staying in the same state as a transition", () => {
    const selfLoops = ORDER_STATES.filter((state) => isLegalOrderTransition(state, state));
    expect(selfLoops).toEqual([]);
  });

  it("lets nothing leave a terminal state", () => {
    const escapes = TERMINAL_ORDER_STATES.flatMap((from) =>
      ORDER_STATES.filter((to) => isLegalOrderTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(escapes).toEqual([]);
  });
});

describe("the state groupings a caller reasons with", () => {
  it("counts exactly the four terminal outcomes as terminal", () => {
    expect([...TERMINAL_ORDER_STATES].sort()).toEqual(["CANCELED", "EXPIRED", "FILLED", "REJECTED"]);
    expect(ORDER_STATES.filter(isTerminalOrderState)).toHaveLength(4);
  });

  it("treats only an acknowledged or partially filled order as live at the venue", () => {
    expect(ORDER_STATES.filter(isLiveOrderState)).toEqual(["ACKNOWLEDGED", "PARTIALLY_FILLED"]);
    expect([...LIVE_ORDER_STATES]).toEqual(["ACKNOWLEDGED", "PARTIALLY_FILLED"]);
  });

  it("never offers an unconfirmed state as something reconciliation can resolve to", () => {
    // UNKNOWN and CANCEL_PENDING are the two states that MEAN "not
    // confirmed". If either appeared here, reconciliation could "resolve" an
    // UNKNOWN order into another limbo and a caller could believe the
    // resolution was an answer.
    expect(CONFIRMED_VENUE_STATES).not.toContain("UNKNOWN");
    expect(CONFIRMED_VENUE_STATES).not.toContain("CANCEL_PENDING");
    expect(CONFIRMED_VENUE_STATES).not.toContain("PROPOSED");
    expect(CONFIRMED_VENUE_STATES).not.toContain("VALIDATED");
    expect(CONFIRMED_VENUE_STATES).not.toContain("RESERVED");
    expect(CONFIRMED_VENUE_STATES).not.toContain("SUBMITTING");
  });
});
