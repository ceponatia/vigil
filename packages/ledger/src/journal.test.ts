import { describe, expect, it } from "vitest";

import {
  accountKey,
  counterAccount,
  holdingsAccount,
  ACCOUNT_FAMILIES,
  type AccountFamily,
} from "./accounts";
import { rebuildBalances } from "./balances";
import * as ledger from "./index";
import {
  buildEntry,
  postEntry,
  reverseEntry,
  ENTRY_KINDS,
  ENTRY_KIND_ALLOWED_FAMILIES,
  type EntryKind,
  type JournalEntry,
} from "./journal";
import {
  at,
  twoLineEntry,
  TEST_STABLE_ASSET,
  TEST_STABLE_SCALE,
  TEST_VOLATILE_ASSET,
  TEST_VOLATILE_SCALE,
} from "./test-support/journal-fixtures";

// The defects this file kills:
//   * an entry that balances "overall" by netting two different assets
//     against each other, which silently invents an exchange rate;
//   * a deposit booked as profit;
//   * a correction applied by editing what was already posted, which
//     destroys the record of what the application believed at the time.

const availableAccount = holdingsAccount(TEST_STABLE_ASSET, "available");
const contributedAccount = counterAccount("contributed-capital", TEST_STABLE_ASSET);

function contribution(entryId: string, amountBase: bigint): JournalEntry {
  return twoLineEntry({ entryId, kind: "contribution", debit: availableAccount, credit: contributedAccount, amountBase });
}

describe("entry balancing", () => {
  it("accepts a two-asset trade whose legs balance per asset — a ledger that required a single cross-asset total would have to invent a price to post any swap at all", () => {
    const built = buildEntry({
      entryId: "entry-trade",
      kind: "trade",
      occurredAt: at("2026-01-02T03:04:05.000Z"),
      recordedAt: at("2026-01-02T03:04:06.000Z"),
      correlationId: "corr-trade",
      idempotencyKey: "idem-trade",
      lines: [
        {
          account: holdingsAccount(TEST_STABLE_ASSET, "available"),
          scale: TEST_STABLE_SCALE,
          amountBase: 100_000_000n,
          direction: "credit",
        },
        {
          account: counterAccount("exchange", TEST_STABLE_ASSET),
          scale: TEST_STABLE_SCALE,
          amountBase: 100_000_000n,
          direction: "debit",
        },
        {
          account: holdingsAccount(TEST_VOLATILE_ASSET, "available"),
          scale: TEST_VOLATILE_SCALE,
          amountBase: 2_500_000_000_000_000_000n,
          direction: "debit",
        },
        {
          account: counterAccount("exchange", TEST_VOLATILE_ASSET),
          scale: TEST_VOLATILE_SCALE,
          amountBase: 2_500_000_000_000_000_000n,
          direction: "credit",
        },
      ],
    });

    expect(built.outcome).toBe("valid");
  });

  it("refuses an entry whose debits and credits match only when two different assets are added together — catches a balancing check that sums every line regardless of asset, which would let 100 stable units 'pay for' 100 volatile units", () => {
    const built = buildEntry({
      entryId: "entry-cross-asset",
      kind: "trade",
      occurredAt: at("2026-01-02T03:04:05.000Z"),
      recordedAt: at("2026-01-02T03:04:06.000Z"),
      correlationId: "corr-cross",
      idempotencyKey: "idem-cross",
      lines: [
        {
          account: holdingsAccount(TEST_STABLE_ASSET, "available"),
          scale: TEST_STABLE_SCALE,
          amountBase: 100n,
          direction: "credit",
        },
        {
          account: holdingsAccount(TEST_VOLATILE_ASSET, "available"),
          scale: TEST_VOLATILE_SCALE,
          amountBase: 100n,
          direction: "debit",
        },
      ],
    });

    expect(built.outcome).toBe("refused");
    if (built.outcome === "refused") {
      expect(built.refusal.reason).toEqual({ source: "ledger", code: "UNBALANCED_ENTRY" });
    }
  });

  it("refuses one asset posted at two scales in the same entry — catches a scale carried per line without a consistency check, where 1 unit at scale 6 would cancel 1 unit at scale 18", () => {
    const built = buildEntry({
      entryId: "entry-scale-mismatch",
      kind: "contribution",
      occurredAt: at("2026-01-02T03:04:05.000Z"),
      recordedAt: at("2026-01-02T03:04:06.000Z"),
      correlationId: "corr-scale",
      idempotencyKey: "idem-scale",
      lines: [
        { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "debit" },
        { account: contributedAccount, scale: TEST_VOLATILE_SCALE, amountBase: 1n, direction: "credit" },
      ],
    });

    expect(built.outcome).toBe("refused");
    if (built.outcome === "refused") {
      expect(built.refusal.reason.code).toBe("SCALE_MISMATCH");
    }
  });

  it("refuses a zero or negative posting — catches an implementation that let direction and sign both carry meaning, where a negative debit is an undocumented credit", () => {
    for (const amountBase of [0n, -1n]) {
      const built = buildEntry({
        entryId: `entry-nonpositive-${amountBase.toString()}`,
        kind: "contribution",
        occurredAt: at("2026-01-02T03:04:05.000Z"),
        recordedAt: at("2026-01-02T03:04:06.000Z"),
        correlationId: "corr-nonpositive",
        idempotencyKey: `idem-nonpositive-${amountBase.toString()}`,
        lines: [
          { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase, direction: "debit" },
          { account: contributedAccount, scale: TEST_STABLE_SCALE, amountBase, direction: "credit" },
        ],
      });

      expect(built.outcome).toBe("refused");
    }
  });
});

// Derived from the registry itself: a kind added later with no thought about
// which families it may touch shows up here as a new case, not as silence.
const forbiddenFamilyCases: ReadonlyArray<{ kind: EntryKind; family: Exclude<AccountFamily, "holdings"> }> =
  ENTRY_KINDS.flatMap((kind) =>
    ACCOUNT_FAMILIES.filter(
      (family): family is Exclude<AccountFamily, "holdings"> =>
        family !== "holdings" && !ENTRY_KIND_ALLOWED_FAMILIES[kind].includes(family),
    ).map((family) => ({ kind, family })),
  );

describe("entry kind and account family", () => {
  it("has at least one forbidden pairing to check — an ENTRY_KIND_ALLOWED_FAMILIES that allowed everything would make every case below vanish and report green", () => {
    expect(forbiddenFamilyCases.length).toBeGreaterThan(0);
  });

  it.each(forbiddenFamilyCases)(
    "refuses a $kind entry that posts to a $family account — catches a ledger that trusts its callers to book money to the right family",
    ({ kind, family }) => {
      const built = buildEntry({
        entryId: `entry-${kind}-${family}`,
        kind,
        occurredAt: at("2026-01-02T03:04:05.000Z"),
        recordedAt: at("2026-01-02T03:04:06.000Z"),
        correlationId: "corr-family",
        idempotencyKey: `idem-${kind}-${family}`,
        lines: [
          { account: counterAccount(family, TEST_STABLE_ASSET), scale: TEST_STABLE_SCALE, amountBase: 5n, direction: "debit" },
          { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 5n, direction: "credit" },
        ],
      });

      expect(built.outcome).toBe("refused");
      if (built.outcome === "refused") {
        expect(built.refusal.reason.code).toBe("ENTRY_KIND_ACCOUNT_MISMATCH");
      }
    },
  );

  it("refuses a contribution posted to realized-pnl specifically — this is the deposit-booked-as-profit defect, which would inflate performance and clear a drawdown pause that is still in force", () => {
    expect(ENTRY_KIND_ALLOWED_FAMILIES.contribution).not.toContain("realized-pnl");
  });
});

describe("corrections are reversing entries, never edits", () => {
  it("records the mistake, its reversal, and the correction as three entries whose gross totals still show all three — an in-place edit would leave the ledger claiming the corrected amount was what happened all along", () => {
    const wrong = contribution("entry-wrong", 500_000_000n);
    const snapshot = structuredClone(wrong);

    const first = postEntry([], wrong);
    expect(first.outcome).toBe("posted");
    if (first.outcome !== "posted") {
      return;
    }

    const reversal = reverseEntry(wrong, {
      entryId: "entry-reversal",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-entry-wrong",
      idempotencyKey: "idem-entry-reversal",
    });
    expect(reversal.outcome).toBe("valid");
    if (reversal.outcome !== "valid") {
      return;
    }

    const second = postEntry(first.entries, reversal.entry);
    expect(second.outcome).toBe("posted");
    if (second.outcome !== "posted") {
      return;
    }

    const third = postEntry(second.entries, contribution("entry-corrected", 450_000_000n));
    expect(third.outcome).toBe("posted");
    if (third.outcome !== "posted") {
      return;
    }

    expect(third.entries).toHaveLength(3);
    // The posted entry is untouched by everything that followed it.
    expect(wrong).toEqual(snapshot);

    const rebuilt = rebuildBalances(third.entries);
    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") {
      return;
    }

    const available = rebuilt.balances.get(accountKey(availableAccount));
    expect(available).toBeDefined();
    if (available !== undefined) {
      // Net is the corrected amount; gross still carries the original and
      // its reversal, which is the difference between a correction and an
      // erasure.
      expect(available.debitBase - available.creditBase).toBe(450_000_000n);
      expect(available.debitBase).toBe(950_000_000n);
      expect(available.creditBase).toBe(500_000_000n);
    }
  });

  it("exports no function that edits or deletes a posted entry — catches the next slice adding an updateEntry() convenience because a correction felt like too much ceremony", () => {
    const mutatingNames = Object.keys(ledger).filter((name) =>
      /^(update|edit|delete|remove|amend|mutate|overwrite|patch)/i.test(name),
    );

    expect(mutatingNames).toEqual([]);
  });

  it("does not mutate the sequence it was given — catches a postEntry that pushed onto the caller's array, so a refused post would already have changed the journal", () => {
    const entries = [contribution("entry-a", 1n)];
    const result = postEntry(entries, contribution("entry-b", 2n));

    expect(entries).toHaveLength(1);
    expect(result.outcome).toBe("posted");
  });
});

describe("postEntry duplicate and reversal guards", () => {
  it("refuses a second entry with the same idempotency key — catches an at-least-once delivery posting the same deposit twice", () => {
    const entries = [contribution("entry-one", 10n)];
    const duplicate = twoLineEntry({
      entryId: "entry-two",
      kind: "contribution",
      debit: availableAccount,
      credit: contributedAccount,
      amountBase: 10n,
      idempotencyKey: "idem-entry-one",
    });

    const result = postEntry(entries, duplicate);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("DUPLICATE_IDEMPOTENCY_KEY");
    }
  });

  it("refuses re-posting the same entry id — catches a retry loop that replays an entry it already wrote", () => {
    const entry = contribution("entry-same", 10n);
    const result = postEntry([entry], entry);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("DUPLICATE_ENTRY_ID");
    }
  });

  it("refuses a reversal of an entry that is not in the journal — catches a correction applied against the wrong journal, which would post a balance change with nothing behind it", () => {
    const orphan = reverseEntry(contribution("entry-absent", 10n), {
      entryId: "entry-orphan-reversal",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-orphan",
      idempotencyKey: "idem-orphan",
    });
    expect(orphan.outcome).toBe("valid");
    if (orphan.outcome !== "valid") {
      return;
    }

    const result = postEntry([contribution("entry-other", 10n)], orphan.entry);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("UNKNOWN_REVERSAL_TARGET");
    }
  });

  it("refuses a second reversal of the same entry — catches a retried correction that would subtract the same amount twice", () => {
    const original = contribution("entry-original", 10n);
    const firstReversal = reverseEntry(original, {
      entryId: "entry-reversal-1",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-original",
      idempotencyKey: "idem-reversal-1",
    });
    const secondReversal = reverseEntry(original, {
      entryId: "entry-reversal-2",
      occurredAt: at("2026-01-03T00:00:02.000Z"),
      recordedAt: at("2026-01-03T00:00:03.000Z"),
      correlationId: "corr-original",
      idempotencyKey: "idem-reversal-2",
    });
    expect(firstReversal.outcome).toBe("valid");
    expect(secondReversal.outcome).toBe("valid");
    if (firstReversal.outcome !== "valid" || secondReversal.outcome !== "valid") {
      return;
    }

    const result = postEntry([original, firstReversal.entry], secondReversal.entry);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("DUPLICATE_REVERSAL");
    }
  });
});
