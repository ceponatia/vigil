import { describe, expect, it } from "vitest";

import {
  accountKey,
  counterAccount,
  holdingsAccount,
  ACCOUNT_FAMILIES,
  type AccountFamily,
  type HoldingsState,
} from "./accounts";
import { rebuildBalances } from "./balances";
import * as ledger from "./index";
import {
  buildEntry,
  describeReversalMismatch,
  parseJournalEntry,
  postEntry,
  reverseEntry,
  ENTRY_KINDS,
  ENTRY_KIND_ALLOWED_FAMILIES,
  RESERVATION_POSTING_SHAPES,
  type EntryKind,
  type EntryProvenance,
  type EntryValidation,
  type JournalEntry,
} from "./journal";
import {
  at,
  twoLineEntry,
  TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
        provenance: TEST_PROVENANCE,
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
        provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
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
      provenance: TEST_PROVENANCE,
    });
    const secondReversal = reverseEntry(original, {
      entryId: "entry-reversal-2",
      occurredAt: at("2026-01-03T00:00:02.000Z"),
      recordedAt: at("2026-01-03T00:00:03.000Z"),
      correlationId: "corr-original",
      idempotencyKey: "idem-reversal-2",
      provenance: TEST_PROVENANCE,
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

describe("the reversal link and the persistence boundary", () => {
  it("refuses a reversal that names no original, and any other kind that claims to reverse one — catches a reversal link filled in by convention rather than checked, where a correction subtracts from an entry nobody can identify (the ledger half of the journal_entries_reversal_link check constraint)", () => {
    const lines = [
      { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "debit" as const },
      { account: contributedAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "credit" as const },
    ];
    const shared = {
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-reversal-link",
      lines,
    };

    const reversalWithoutTarget = buildEntry({
      ...shared,
      entryId: "entry-reversal-without-target",
      kind: "reversal",
      idempotencyKey: "idem-reversal-without-target",
      provenance: TEST_PROVENANCE,
    });
    const contributionClaimingOne = buildEntry({
      ...shared,
      entryId: "entry-contribution-claiming-reversal",
      kind: "contribution",
      idempotencyKey: "idem-contribution-claiming-reversal",
      provenance: TEST_PROVENANCE,
      reversesEntryId: "entry-somewhere-else",
    });

    for (const built of [reversalWithoutTarget, contributionClaimingOne]) {
      expect(built.outcome).toBe("refused");
      if (built.outcome === "refused") {
        expect(built.refusal.reason).toEqual({ source: "ledger", code: "MALFORMED_ENTRY" });
      }
    }
  });

  it("re-validates a persisted record and refuses a corrupt one with a diagnostic instead of throwing — catches a rebuild that trusts a database row it never checked, and one that a single bad row takes down entirely (docs/resilience.md §5)", () => {
    const persisted: unknown = contribution("entry-persisted", 10n);
    const parsed = parseJournalEntry(persisted);

    expect(parsed.outcome).toBe("valid");
    if (parsed.outcome === "valid") {
      expect(parsed.entry.entryId).toBe("entry-persisted");
    }

    // Well-formed text naming a calendar day that does not exist: Date.parse
    // rolls it forward to March 2 rather than failing, so a NaN check alone
    // would let this row through.
    const corrupt: unknown = { ...contribution("entry-corrupt", 10n), occurredAt: "2026-02-30T00:00:00.000Z" };

    expect(() => parseJournalEntry(corrupt)).not.toThrow();
    const refusedParse = parseJournalEntry(corrupt);
    expect(refusedParse.outcome).toBe("refused");
    if (refusedParse.outcome === "refused") {
      expect(refusedParse.refusal.reason).toEqual({ source: "ledger", code: "MALFORMED_ENTRY" });
    }
  });
});

// Finding 3: a reversal consumes the target's single correction slot, so
// proving the target exists is not enough — the postings have to be the
// target's own, inverted.
describe("a reversal must mirror the entry it reverses", () => {
  const target = contribution("entry-to-correct", 500_000_000n);

  function reversalWithLines(lines: JournalEntry["lines"]): JournalEntry {
    const built = buildEntry({
      entryId: "entry-fake-reversal",
      kind: "reversal",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-fake-reversal",
      idempotencyKey: "idem-fake-reversal",
      provenance: TEST_PROVENANCE,
      reversesEntryId: target.entryId,
      lines,
    });
    if (built.outcome === "refused") {
      throw new Error(`fixture reversal did not build: ${built.refusal.reason.code}`);
    }
    return built.entry;
  }

  it("accepts the exact inverse produced by reverseEntry — the baseline the refusals below are measured against", () => {
    const mirrored = reverseEntry(target, {
      entryId: "entry-true-reversal",
      occurredAt: at("2026-01-03T00:00:00.000Z"),
      recordedAt: at("2026-01-03T00:00:01.000Z"),
      correlationId: "corr-entry-to-correct",
      idempotencyKey: "idem-true-reversal",
      provenance: TEST_PROVENANCE,
    });
    expect(mirrored.outcome).toBe("valid");
    if (mirrored.outcome !== "valid") {
      return;
    }

    expect(postEntry([target], mirrored.entry).outcome).toBe("posted");
    expect(describeReversalMismatch(target, mirrored.entry)).toBeNull();
  });

  it("refuses a reversal that posts a different amount — catches a stale caller consuming the target's one correction slot with a balance change of its own choosing, after which the real correction can never be posted", () => {
    const wrongAmount = reversalWithLines([
      { account: contributedAccount, scale: TEST_STABLE_SCALE, amountBase: 400_000_000n, direction: "debit" },
      { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 400_000_000n, direction: "credit" },
    ]);

    const result = postEntry([target], wrongAmount);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("REVERSAL_NOT_MIRRORED");
    }
  });

  it("refuses a reversal that moves the same amount through different accounts — catches a correction that nets to zero overall while quietly moving value between two accounts it was never about", () => {
    const wrongAccounts = reversalWithLines([
      { account: counterAccount("fees", TEST_STABLE_ASSET), scale: TEST_STABLE_SCALE, amountBase: 500_000_000n, direction: "debit" },
      { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 500_000_000n, direction: "credit" },
    ]);

    const result = postEntry([target], wrongAccounts);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("REVERSAL_NOT_MIRRORED");
    }
  });

  it("refuses the same forgery on replay, not only on the incremental path — catches the rule living in postEntry alone, where a row written by anything else rebuilds without complaint", () => {
    const forged = reversalWithLines([
      { account: contributedAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "debit" },
      { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "credit" },
    ]);

    const rebuilt = rebuildBalances([target, forged]);

    expect(rebuilt.outcome).toBe("refused");
    if (rebuilt.outcome === "refused") {
      expect(rebuilt.refusal.reason.code).toBe("REVERSAL_NOT_MIRRORED");
      expect(rebuilt.entryId).toBe("entry-fake-reversal");
    }
  });
});

// Finding 4: "only holdings accounts" let a hold post the inverse move.
describe("reservation postings are the exact state move they name", () => {
  function reservationEntry(kind: "reservation-hold" | "reservation-release", debitState: HoldingsState, creditState: HoldingsState) {
    return buildEntry({
      entryId: `entry-${kind}-${debitState}`,
      kind,
      occurredAt: at("2026-01-02T03:04:05.000Z"),
      recordedAt: at("2026-01-02T03:04:06.000Z"),
      correlationId: "corr-reservation-shape",
      idempotencyKey: `idem-${kind}-${debitState}`,
      provenance: TEST_PROVENANCE,
      lines: [
        {
          account: holdingsAccount(TEST_STABLE_ASSET, debitState),
          scale: TEST_STABLE_SCALE,
          amountBase: 5n,
          direction: "debit",
        },
        {
          account: holdingsAccount(TEST_STABLE_ASSET, creditState),
          scale: TEST_STABLE_SCALE,
          amountBase: 5n,
          direction: "credit",
        },
      ],
    });
  }

  it("refuses a hold that debits available and credits reserved — this is the inverse move wearing a hold's name: it releases capital another intent has already committed while every log line still reads `reservation-hold`", () => {
    const result = reservationEntry("reservation-hold", "available", "reserved");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("RESERVATION_POSTING_SHAPE");
    }
  });

  it("refuses a release that debits reserved and credits available — the same defect in the other direction, which would hold funds under cover of releasing them", () => {
    const result = reservationEntry("reservation-release", "reserved", "available");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("RESERVATION_POSTING_SHAPE");
    }
  });

  it("refuses a hold that moves funds out of a locked state — catches a posting that launders a staked or in-flight balance into `reserved`, from which it would look spendable", () => {
    for (const state of ["staked", "unbonding", "pending-transfer", "exit-queued"] as const) {
      const result = reservationEntry("reservation-hold", "reserved", state);

      expect([state, result.outcome]).toEqual([state, "refused"]);
    }
  });

  it("accepts exactly the move each kind names — derived from RESERVATION_POSTING_SHAPES, so a registry edited without thinking shows up here", () => {
    for (const [kind, shape] of Object.entries(RESERVATION_POSTING_SHAPES)) {
      const result = reservationEntry(kind === "reservation-hold" ? "reservation-hold" : "reservation-release", shape.debit, shape.credit);

      expect([kind, result.outcome]).toEqual([kind, "valid"]);
    }
  });
});

// Finding 5: postEntry saw one entry at a time.
describe("scale consistency across the journal", () => {
  it("refuses an entry that posts an asset at a scale the journal already contradicts — catches an append that succeeds while the rebuild of the very same journal refuses, which is a process that cannot restart from what it just wrote", () => {
    const atSix = contribution("entry-scale-six", 1_000_000n);
    const atEighteen = twoLineEntry({
      entryId: "entry-scale-eighteen",
      kind: "contribution",
      debit: availableAccount,
      credit: contributedAccount,
      amountBase: 1_000_000n,
      scale: TEST_VOLATILE_SCALE,
    });

    const result = postEntry([atSix], atEighteen);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("SCALE_MISMATCH");
    }
    // The two paths agree: what postEntry refuses, a rebuild refuses too.
    expect(rebuildBalances([atSix, atEighteen]).outcome).toBe("refused");
  });
});

// Finding 8: provenance is required, not decorative.
describe("provenance", () => {
  it("refuses an entry that does not name the policy and strategy versions that produced it — catches a record whose outcome can never be attributed to the behavior that caused it, which makes every later champion/challenger comparison meaningless", () => {
    for (const provenance of [
      { ...TEST_PROVENANCE, policyVersion: "" },
      { ...TEST_PROVENANCE, strategyVersion: "   " },
    ]) {
      const result = twoLineEntryOrRefusal(provenance);

      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason.code).toBe("MISSING_PROVENANCE");
      }
    }
  });

  it("accepts a null model version — catches a rule that demands every field, which would make a deterministic posting impossible to record at all, since no LLM produced it", () => {
    const result = twoLineEntryOrRefusal({ ...TEST_PROVENANCE, modelVersion: null });

    expect(result.outcome).toBe("valid");
  });
});

function twoLineEntryOrRefusal(provenance: EntryProvenance): EntryValidation {
  return buildEntry({
    entryId: "entry-provenance",
    kind: "contribution",
    occurredAt: at("2026-01-02T03:04:05.000Z"),
    recordedAt: at("2026-01-02T03:04:06.000Z"),
    correlationId: "corr-provenance",
    idempotencyKey: "idem-provenance",
    provenance,
    lines: [
      { account: availableAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "debit" },
      { account: contributedAccount, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "credit" },
    ],
  });
}
