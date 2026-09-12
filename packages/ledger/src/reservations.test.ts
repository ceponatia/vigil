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
import { postEntry, type JournalEntry } from "./journal";
import {
  releaseRequest,
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

  it("holds the funds once when the same reservation request is delivered twice — catches an at-least-once dispatcher that re-plans a hold under a fresh entry id and reserves the same capital for one intent twice over; the store-level half of this claim is packages/db/src/store/reservation-store.int.test.ts", () => {
    const funded = [fundingEntry("available")];
    const first = planReservation(sheetFrom(funded), reservationRequest({ amountBase: 250_000_000n }));
    expect(first.outcome).toBe("reserved");
    if (first.outcome !== "reserved") {
      return;
    }

    const journal = postEntry(funded, first.entry);
    expect(journal.outcome).toBe("posted");
    if (journal.outcome !== "posted") {
      return;
    }

    // Redelivered with a freshly generated entry id, as a retrying
    // dispatcher would: only the idempotency key still ties it to the first
    // delivery, and the arithmetic alone still finds it affordable.
    const redelivered = planReservation(
      sheetFrom(journal.entries),
      reservationRequest({ amountBase: 250_000_000n, entryId: "entry-reservation-1-retry" }),
    );
    expect(redelivered.outcome).toBe("reserved");
    if (redelivered.outcome !== "reserved") {
      return;
    }

    const second = postEntry(journal.entries, redelivered.entry);

    expect(second.outcome).toBe("refused");
    if (second.outcome === "refused") {
      expect(second.refusal.reason).toEqual({ source: "ledger", code: "DUPLICATE_IDEMPOTENCY_KEY" });
    }
    expect(holdingsBase(sheetFrom(journal.entries), TEST_STABLE_ASSET, "reserved")).toBe(250_000_000n);
    expect(holdingsBase(sheetFrom(journal.entries), TEST_STABLE_ASSET, "available")).toBe(FUNDED_BASE - 250_000_000n);
  });

  it("refuses a reservation of zero or fewer base units — catches a path where direction and sign both carry meaning, so a negative request reads as a hold and moves capital the other way", () => {
    const sheet = sheetFrom([fundingEntry("available")]);

    for (const amountBase of [0n, -1n]) {
      const held = planReservation(sheet, reservationRequest({ amountBase }));

      expect(held.outcome).toBe("refused");
      if (held.outcome === "refused") {
        expect(held.refusal.reason).toEqual({ source: "ledger", code: "NON_POSITIVE_AMOUNT" });
      }
    }
  });

  it("refuses a reservation whose attempt is not a positive whole number — catches a retry that arrives unnumbered or as attempt 0, which would leave the store's (intent_id, attempt) uniqueness unable to tell a versioned retry from a second authorization to spend the same intent", () => {
    const sheet = sheetFrom([fundingEntry("available")]);

    for (const attempt of [0, -1, 1.5]) {
      const result = planReservation(sheet, reservationRequest({ amountBase: 1n, attempt }));

      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason).toEqual({ source: "ledger", code: "MALFORMED_ENTRY" });
      }
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

  it("refuses staked, unbonding, and exit-queued funds with the policy code YIELD_LOCKED, and the other two unreservable states with a ledger diagnostic — the case above reads the same table it checks, so this is the pin on what docs/policy.md's YIELD_LOCKED actually covers: locked yield, never a balance that is merely committed elsewhere or in transit", () => {
    const statesRefusedWith = (source: string, code: string): readonly HoldingsState[] =>
      HOLDINGS_STATES.filter((state) => {
        const declared = HOLDINGS_STATE_RESERVABILITY[state];
        return !declared.reservable && declared.refusal.reason.source === source && declared.refusal.reason.code === code;
      });

    expect(statesRefusedWith("policy", "YIELD_LOCKED")).toEqual(["staked", "unbonding", "exit-queued"]);
    expect(statesRefusedWith("ledger", "STATE_NOT_RESERVABLE")).toEqual(["reserved", "pending-transfer"]);
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
    const released = planRelease(afterHold, releaseRequest({ amountBase: 250_000_000n, entryId: "entry-release-1" }));

    expect(released.outcome).toBe("released");
    if (released.outcome !== "released") {
      return;
    }

    const afterRelease = sheetFrom([...funded, held.entry, released.entry]);
    expect(holdingsBase(afterRelease, TEST_STABLE_ASSET, "reserved")).toBe(350_000_000n);
    expect(holdingsBase(afterRelease, TEST_STABLE_ASSET, "available")).toBe(650_000_000n);
  });

  it("refuses a release of zero or fewer base units — catches the same sign confusion on the way back, where a negative release would take capital out of `available` under the name of freeing it", () => {
    const sheet = sheetFrom([fundingEntry("available")]);

    for (const amountBase of [0n, -1n]) {
      const freed = planRelease(sheet, releaseRequest({ amountBase }));

      expect(freed.outcome).toBe("refused");
      if (freed.outcome === "refused") {
        expect(freed.refusal.reason).toEqual({ source: "ledger", code: "NON_POSITIVE_AMOUNT" });
      }
    }
  });

  it("refuses to release more than is on hold — catches a release path that would mint available balance out of an over-stated reservation", () => {
    const result = planRelease(
      sheetFrom([fundingEntry("available")]),
      releaseRequest({ amountBase: 1n, entryId: "entry-release-2" }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("RELEASE_EXCEEDS_RESERVED");
    }
  });
});
