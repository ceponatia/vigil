import { describe, expect, it } from "vitest";

import { accountKey, counterAccount, holdingsAccount } from "./accounts";
import { compareBalanceSheets, holdingsBase, netBase, rebuildBalances, type BalanceSheet } from "./balances";
import { postEntry, reverseEntry, type JournalEntry } from "./journal";
import { at, sheetFrom, twoLineEntry, TEST_PROVENANCE, TEST_STABLE_ASSET } from "./test-support/journal-fixtures";

// The defect this file kills: a restart that rebuilds balances which are
// *plausible* rather than *identical* — a replay that drops a reversal, or
// counts a row twice, and reports a healthy balance sheet either way.

const availableAccount = holdingsAccount(TEST_STABLE_ASSET, "available");
const contributedAccount = counterAccount("contributed-capital", TEST_STABLE_ASSET);

function contribution(entryId: string, amountBase: bigint): JournalEntry {
  return twoLineEntry({ entryId, kind: "contribution", debit: availableAccount, credit: contributedAccount, amountBase });
}

describe("rebuildBalances", () => {
  it("keeps debits and credits as separate running totals — catches a projection that stored only the net, where a corrected entry and an entry that never happened become indistinguishable", () => {
    const original = contribution("entry-1", 500n);
    const reversal = reverseEntry(original, {
      entryId: "entry-2",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-entry-1",
      idempotencyKey: "idem-entry-2",
      provenance: TEST_PROVENANCE,
    });
    expect(reversal.outcome).toBe("valid");
    if (reversal.outcome !== "valid") {
      return;
    }

    const corrected = sheetFrom([original, reversal.entry, contribution("entry-3", 450n)]);
    const neverWrong = sheetFrom([contribution("entry-4", 450n)]);

    const correctedBalance = corrected.get(accountKey(availableAccount));
    const cleanBalance = neverWrong.get(accountKey(availableAccount));
    expect(correctedBalance).toBeDefined();
    expect(cleanBalance).toBeDefined();
    if (correctedBalance === undefined || cleanBalance === undefined) {
      return;
    }

    expect(netBase(correctedBalance)).toBe(netBase(cleanBalance));
    expect(correctedBalance.debitBase).not.toBe(cleanBalance.debitBase);
    expect(compareBalanceSheets(corrected, neverWrong)).not.toEqual([]);
  });

  it("refuses a journal that replays the same entry twice — catches a rebuild fed by an unbounded or overlapping read, which would double every balance it touched", () => {
    const entry = contribution("entry-repeated", 10n);
    const result = rebuildBalances([entry, entry]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("DUPLICATE_ENTRY_ID");
      expect(result.entryId).toBe("entry-repeated");
    }
  });

  it("refuses a journal whose reversal names an entry it has not yet seen, and says which entry — catches a rebuild that reads entries out of recorded order, so a correction lands before what it corrects", () => {
    const original = contribution("entry-original", 10n);
    const reversal = reverseEntry(original, {
      entryId: "entry-early-reversal",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-entry-original",
      idempotencyKey: "idem-early-reversal",
      provenance: TEST_PROVENANCE,
    });
    expect(reversal.outcome).toBe("valid");
    if (reversal.outcome !== "valid") {
      return;
    }

    const result = rebuildBalances([reversal.entry, original]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("UNKNOWN_REVERSAL_TARGET");
      expect(result.entryId).toBe("entry-early-reversal");
    }
  });

  it("rebuilds an empty journal into an empty sheet rather than refusing — catches a rebuild that treats a fresh install as a corrupt one", () => {
    const result = rebuildBalances([]);

    expect(result.outcome).toBe("rebuilt");
    if (result.outcome === "rebuilt") {
      expect(result.balances.size).toBe(0);
      expect(result.entryCount).toBe(0);
    }
  });

  it("reports a zero balance for an account with no postings — catches a lookup that returns undefined and lets `undefined - amount` become NaN downstream", () => {
    expect(holdingsBase(sheetFrom([contribution("entry-only", 10n)]), TEST_STABLE_ASSET, "staked")).toBe(0n);
  });

  it("refuses a journal that posts one asset at two scales in different entries, and says which entry — catches a rebuild that tracks scale per line instead of per asset, where one row recorded at scale 18 is folded into a scale-6 account twelve orders of magnitude too large", () => {
    const atSixDecimals = contribution("entry-scale-6", 1_000_000n);
    const atEighteenDecimals = twoLineEntry({
      entryId: "entry-scale-18",
      kind: "contribution",
      debit: availableAccount,
      credit: contributedAccount,
      amountBase: 1_000_000n,
      scale: 18,
    });

    const result = rebuildBalances([atSixDecimals, atEighteenDecimals]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("SCALE_MISMATCH");
      expect(result.entryId).toBe("entry-scale-18");
    }
  });

  it("refuses an entry that names itself as the entry it reverses, exactly as postEntry does — catches a rebuild that records the entry id before checking the reversal target, where a self-reversal replays cleanly and then blocks the genuine reversal of that entry as a duplicate", () => {
    const selfReversal = twoLineEntry({
      entryId: "entry-ouroboros",
      kind: "reversal",
      debit: availableAccount,
      credit: contributedAccount,
      amountBase: 10n,
      reversesEntryId: "entry-ouroboros",
    });

    const replayed = rebuildBalances([selfReversal]);
    const posted = postEntry([], selfReversal);

    expect(replayed.outcome).toBe("refused");
    if (replayed.outcome === "refused") {
      expect(replayed.refusal.reason.code).toBe("UNKNOWN_REVERSAL_TARGET");
      expect(replayed.entryId).toBe("entry-ouroboros");
    }
    // The incremental path and the replay path agree about the same entry;
    // a journal one of them accepts and the other refuses is a journal that
    // cannot be restarted from.
    expect(posted.outcome).toBe("refused");
    if (posted.outcome === "refused") {
      expect(posted.refusal.reason.code).toBe("UNKNOWN_REVERSAL_TARGET");
    }
  });
});

describe("compareBalanceSheets", () => {
  it("reports nothing for two sheets rebuilt from the same journal — the assertion a replay makes when it succeeds", () => {
    const entries = [contribution("entry-a", 10n), contribution("entry-b", 20n)];

    expect(compareBalanceSheets(sheetFrom(entries), sheetFrom(entries))).toEqual([]);
  });

  it("reports an account present on only one side — catches a comparison that iterates one sheet's keys, so an account the rebuild invented, or lost, passes unnoticed", () => {
    const empty: BalanceSheet = new Map();
    const differences = compareBalanceSheets(sheetFrom([contribution("entry-a", 10n)]), empty);

    expect(differences).toHaveLength(2);
    expect(differences.every((difference) => difference.actualNetBase === null)).toBe(true);
  });

  it("reports an account whose two sides agree on the amount but disagree on the scale — catches a reconciliation that compares only the net, where a scale drift between the stored projection and the rebuild reads as agreement about two different sums of money", () => {
    const atSixDecimals = sheetFrom([contribution("entry-scale-a", 1_000_000n)]);
    const atEighteenDecimals = sheetFrom([
      twoLineEntry({
        entryId: "entry-scale-a",
        kind: "contribution",
        debit: availableAccount,
        credit: contributedAccount,
        amountBase: 1_000_000n,
        scale: 18,
      }),
    ]);

    const differences = compareBalanceSheets(atSixDecimals, atEighteenDecimals);

    expect(differences).toHaveLength(2);
    expect(differences.every((difference) => difference.expectedNetBase === difference.actualNetBase)).toBe(true);
  });
});
