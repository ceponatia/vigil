import { describe, expect, it } from "vitest";

import {
  counterAccount,
  holdingsAccount,
  HOLDINGS_STATES,
  HOLDINGS_STATE_RESERVABILITY,
  type HoldingsState,
} from "./accounts";
import { holdingsBase, type BalanceSheet } from "./balances";
import { LEDGER_DIAGNOSTIC_CODES, LEDGER_EMITTED_POLICY_REASON_CODES } from "./diagnostics";
import { planRelease, planReservation } from "./reservations";
import type { JournalEntry } from "./journal";
import {
  at,
  reservationRequest,
  sheetFrom,
  twoLineEntry,
  TEST_STABLE_ASSET,
} from "./test-support/journal-fixtures";

// The defect this file kills: two strategies reserving the same funds. The
// second reservation must be refused on the balance that already reflects
// the first — not on the balance as it was when the pair started.
//
// This is the pure half of that guarantee. Serializing two concurrent
// *processes* is the store's job (packages/db), and is covered by
// tests/fault-injection/concurrent-reservation.int.test.ts.

const FUNDED_BASE = 1_000_000_000n; // 1,000 units at scale 6
const contributedAccount = counterAccount("contributed-capital", TEST_STABLE_ASSET);

function fundingEntry(state: HoldingsState): JournalEntry {
  return twoLineEntry({
    entryId: `entry-fund-${state}`,
    kind: "contribution",
    debit: holdingsAccount(TEST_STABLE_ASSET, state),
    credit: contributedAccount,
    amountBase: FUNDED_BASE,
  });
}

describe("planReservation against already-reserved funds", () => {
  it("refuses the second of two reservations whose sum exceeds the balance, and names what was actually available — catches a check written against the funded balance instead of the current one, which is exactly how two strategies spend the same money", () => {
    const funded = [fundingEntry("available")];
    const first = planReservation(sheetFrom(funded), reservationRequest({ reservationId: "reservation-a", amountBase: 600_000_000n }));

    expect(first.outcome).toBe("reserved");
    if (first.outcome !== "reserved") {
      return;
    }

    const afterFirst = sheetFrom([...funded, first.entry]);
    const second = planReservation(
      afterFirst,
      reservationRequest({ reservationId: "reservation-b", amountBase: 600_000_000n }),
    );

    expect(second.outcome).toBe("refused");
    if (second.outcome === "refused") {
      expect(second.refusal.reason).toEqual({ source: "ledger", code: "INSUFFICIENT_AVAILABLE" });
      expect(second.availableBase).toBe(400_000_000n);
      expect(second.requestedBase).toBe(600_000_000n);
    }

    // The refused attempt changed nothing: only the first hold is on the books.
    expect(holdingsBase(afterFirst, TEST_STABLE_ASSET, "reserved")).toBe(600_000_000n);
    expect(holdingsBase(afterFirst, TEST_STABLE_ASSET, "available")).toBe(400_000_000n);
  });

  it("permits a reservation for exactly the available balance — catches an off-by-one guard written as `<=` that would leave the last base unit permanently unusable", () => {
    const result = planReservation(
      sheetFrom([fundingEntry("available")]),
      reservationRequest({ amountBase: FUNDED_BASE }),
    );

    expect(result.outcome).toBe("reserved");
    if (result.outcome === "reserved") {
      expect(result.availableAfterBase).toBe(0n);
    }
  });

  it("refuses one base unit more than the balance holds — the other side of the same boundary", () => {
    const result = planReservation(
      sheetFrom([fundingEntry("available")]),
      reservationRequest({ amountBase: FUNDED_BASE + 1n }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("INSUFFICIENT_AVAILABLE");
    }
  });

  it("refuses against an empty balance sheet without throwing — catches a lookup that treats a missing account as an error instead of as a zero balance", () => {
    const empty: BalanceSheet = new Map();

    expect(() => planReservation(empty, reservationRequest({ amountBase: 1n }))).not.toThrow();

    const result = planReservation(empty, reservationRequest({ amountBase: 1n }));
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.availableBase).toBe(0n);
    }
  });

  it("refuses a reservation that expires no later than the event it authorizes — catches a window check that admits an already-dead hold, which would authorize a spend nothing can time out", () => {
    const result = planReservation(
      sheetFrom([fundingEntry("available")]),
      reservationRequest({
        amountBase: 1n,
        occurredAt: "2026-01-02T03:04:05.000Z",
        expiresAt: "2026-01-02T03:04:05.000Z",
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("INVALID_RESERVATION_WINDOW");
    }
  });
});

// Registry-derived: a seventh holdings state added later without a
// reservability ruling fails here rather than defaulting to spendable.
describe("which holdings states a reservation may consume", () => {
  it.each(HOLDINGS_STATES)(
    "reserves from %s exactly as HOLDINGS_STATE_RESERVABILITY declares — catches a reservation path that reads a locked or in-flight balance as spendable inventory",
    (state: HoldingsState) => {
      const result = planReservation(
        sheetFrom([fundingEntry(state)]),
        reservationRequest({ amountBase: 100_000_000n, fromState: state }),
      );
      const declared = HOLDINGS_STATE_RESERVABILITY[state];

      if (declared.reservable) {
        expect(result.outcome).toBe("reserved");
      } else {
        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
          expect(result.refusal.reason).toEqual(declared.refusal.reason);
        }
      }
    },
  );

  it("only `available` is reservable — a state list where anything else were spendable would let a staked position fund a trade", () => {
    const reservable = HOLDINGS_STATES.filter((state) => HOLDINGS_STATE_RESERVABILITY[state].reservable);

    expect(reservable).toEqual(["available"]);
  });

  it("keeps the policy and ledger vocabularies apart in every declared refusal — catches a ledger diagnostic smuggled into the policy vocabulary, where docs/policy.md would no longer be the only place reason codes are defined", () => {
    for (const state of HOLDINGS_STATES) {
      const declared = HOLDINGS_STATE_RESERVABILITY[state];
      if (declared.reservable) {
        continue;
      }
      const { reason } = declared.refusal;
      if (reason.source === "policy") {
        expect(LEDGER_EMITTED_POLICY_REASON_CODES).toContain(reason.code);
      } else {
        expect(LEDGER_DIAGNOSTIC_CODES).toContain(reason.code);
      }
    }
  });
});

describe("planRelease", () => {
  it("returns only the amount asked for, leaving the rest on hold — catches a release that assumed the whole reservation, which would hand back capital a partial fill has already spent", () => {
    const funded = [fundingEntry("available")];
    const held = planReservation(sheetFrom(funded), reservationRequest({ amountBase: 600_000_000n }));
    expect(held.outcome).toBe("reserved");
    if (held.outcome !== "reserved") {
      return;
    }

    const afterHold = sheetFrom([...funded, held.entry]);
    const released = planRelease(afterHold, {
      reservationId: "reservation-1",
      intentId: "intent-reservation-1",
      idempotencyKey: "idem-release-1",
      correlationId: "corr-reservation-1",
      entryId: "entry-release-1",
      assetId: TEST_STABLE_ASSET,
      scale: 6,
      amountBase: 250_000_000n,
      occurredAt: at("2026-01-02T03:06:05.000Z"),
      recordedAt: at("2026-01-02T03:06:06.000Z"),
    });

    expect(released.outcome).toBe("released");
    if (released.outcome !== "released") {
      return;
    }

    const afterRelease = sheetFrom([...funded, held.entry, released.entry]);
    expect(holdingsBase(afterRelease, TEST_STABLE_ASSET, "reserved")).toBe(350_000_000n);
    expect(holdingsBase(afterRelease, TEST_STABLE_ASSET, "available")).toBe(650_000_000n);
  });

  it("refuses to release more than is on hold — catches a release path that would mint available balance out of an over-stated reservation", () => {
    const result = planRelease(sheetFrom([fundingEntry("available")]), {
      reservationId: "reservation-1",
      intentId: "intent-reservation-1",
      idempotencyKey: "idem-release-2",
      correlationId: "corr-reservation-1",
      entryId: "entry-release-2",
      assetId: TEST_STABLE_ASSET,
      scale: 6,
      amountBase: 1n,
      occurredAt: at("2026-01-02T03:06:05.000Z"),
      recordedAt: at("2026-01-02T03:06:06.000Z"),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("RELEASE_EXCEEDS_RESERVED");
    }
  });
});
