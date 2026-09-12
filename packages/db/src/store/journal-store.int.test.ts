import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadBalances, loadJournalEntries, postJournalEntry } from "./journal-store";
import {
  counterFamily,
  creditOf,
  debitOf,
  fundingEntry,
  heldIn,
  openLedgerTestDb,
  storeEntry,
  TEST_ASSET,
} from "../test-support/journal-fixtures";

// The defects this file kills, all of them about what a commit leaves
// behind rather than about what the arithmetic says:
//   * the same economic event delivered twice posting twice, so one deposit
//     funds two intents;
//   * a posting that would drive a holdings account below zero arriving as a
//     thrown driver error — or worse, as an entry that persisted while its
//     balance update rolled back, leaving a journal and a projection that
//     disagree about the same money;
//   * a record that is not a double-entry posting reaching the tables at all.
//
// The real-infrastructure facts required are a transaction boundary and the
// `ledger_balances_holdings_never_negative` check constraint. Replacing
// Postgres with an in-memory store would delete these claims rather than
// move them; the arithmetic half already lives in @vigil/ledger's pure
// suites.

const { db, close, reset } = openLedgerTestDb("vigil-journal-store-test");

const FUNDED_BASE = 1_000_000n;

afterAll(close);
beforeEach(reset);

async function netBaseOf(accountKey: string): Promise<bigint> {
  const row = (await loadBalances(db)).find((balance) => balance.accountKey === accountKey);
  return row === undefined ? 0n : row.debitBase - row.creditBase;
}

describe("postJournalEntry", () => {
  it("posts once when the same economic event is delivered twice under a fresh entry id, and reports the entry already stored — catches an at-least-once writer that funds one intent twice, and a duplicate check keyed on the entry id, which a regenerated id defeats", async () => {
    const first = await postJournalEntry(db, fundingEntry("entry-once", FUNDED_BASE));
    const redelivered = await postJournalEntry(db, {
      ...fundingEntry("entry-once-retry", FUNDED_BASE),
      idempotencyKey: "idem-entry-once",
    });

    expect(first.outcome).toBe("posted");
    expect(redelivered.outcome).toBe("duplicate");
    if (redelivered.outcome === "duplicate") {
      expect(redelivered.entryId).toBe("entry-once");
    }

    expect(await loadJournalEntries(db)).toHaveLength(1);
    expect(await netBaseOf(`holdings|available|${TEST_ASSET}`)).toBe(FUNDED_BASE);
  });

  it("refuses a posting that would credit a holdings account below zero and rolls the whole entry back — catches a check constraint surfacing as a crash instead of a diagnostic, and a half-applied entry whose journal and projection disagree", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-funded", FUNDED_BASE))).outcome).toBe("posted");

    const overspend = await postJournalEntry(
      db,
      storeEntry("entry-overspend", "fee", [
        debitOf(counterFamily("fees"), FUNDED_BASE * 2n),
        creditOf(heldIn("available"), FUNDED_BASE * 2n),
      ]),
    );

    expect(overspend.outcome).toBe("refused");
    if (overspend.outcome === "refused") {
      expect(overspend.code).toBe("INSUFFICIENT_AVAILABLE");
    }

    // Only the funding entry survived, and the fee account the refused
    // posting touched first was rolled back with it.
    expect(await loadJournalEntries(db)).toHaveLength(1);
    expect(await netBaseOf(`holdings|available|${TEST_ASSET}`)).toBe(FUNDED_BASE);
    expect((await loadBalances(db)).map((balance) => balance.accountKey)).not.toContain(`fees|-|${TEST_ASSET}`);
  });

  it("refuses a record that is not a double-entry posting before writing anything — catches a single-sided or unparseably-timestamped record reaching the tables, where the constraint that would have caught it fires halfway through a transaction instead of at the door", async () => {
    const singleSided = { ...fundingEntry("entry-single-sided", 1n), lines: [debitOf(heldIn("available"), 1n)] };
    const unparseableInstant = { ...fundingEntry("entry-bad-instant", 1n), occurredAt: "the day before yesterday" };

    for (const malformed of [singleSided, unparseableInstant]) {
      const result = await postJournalEntry(db, malformed);

      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.code).toBe("MALFORMED_ENTRY");
      }
    }

    expect(await loadJournalEntries(db)).toHaveLength(0);
    expect(await loadBalances(db)).toHaveLength(0);
  });
});
