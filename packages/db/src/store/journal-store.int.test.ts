import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { journalEntries, journalLines } from "../schema/journal";
import { describeDriverRefusal, loadBalances, loadJournalEntries, postJournalEntry } from "./journal-store";
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

async function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
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

  it("applies a credit to a holdings account that can afford it — catches the balance projection being written as one upsert, where Postgres checks the proposed (debit 0, credit N) row before resolving the conflict and rejects every spend, fee, and sell leg as an overspend however well funded the account is", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-funds-a-fee", FUNDED_BASE))).outcome).toBe("posted");

    const fee = await postJournalEntry(
      db,
      storeEntry("entry-affordable-fee", "fee", [
        debitOf(counterFamily("fees"), FUNDED_BASE / 4n),
        creditOf(heldIn("available"), FUNDED_BASE / 4n),
      ]),
    );

    expect(fee.outcome).toBe("posted");
    expect(await netBaseOf(`holdings|available|${TEST_ASSET}`)).toBe(FUNDED_BASE - FUNDED_BASE / 4n);
    expect(await netBaseOf(`fees|-|${TEST_ASSET}`)).toBe(FUNDED_BASE / 4n);
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

  it("refuses an entry whose debits and credits do not match for an asset, before writing anything — catches the invariant living only in @vigil/ledger, which packages/db may not import: an entry that never went through the ledger would otherwise post a balance change with nothing on the other side of it", async () => {
    const lopsided = storeEntry("entry-lopsided", "contribution", [
      debitOf(heldIn("available"), 1_000n),
      creditOf(counterFamily("contributed-capital"), 999n),
    ]);

    const result = await postJournalEntry(db, lopsided);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("UNBALANCED_ENTRY");
      expect(result.detail).toContain(TEST_ASSET);
    }
    expect(await loadJournalEntries(db)).toHaveLength(0);
    expect(await loadBalances(db)).toHaveLength(0);
  });

  it("cannot be bypassed: the database itself refuses an unbalanced entry at commit — catches the store's bigint pre-check being the only thing enforcing the rule, so any other writer, repair script, or psql session could leave the journal not adding up", async () => {
    const failure = await errorFrom(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into ${journalEntries} (entry_id, kind, occurred_at, recorded_at, correlation_id, idempotency_key)
          values ('entry-bypass', 'contribution', '2026-01-02T03:04:05Z'::timestamptz, '2026-01-02T03:04:06Z'::timestamptz, 'corr-bypass', 'idem-bypass')
        `);
        await tx.execute(sql`
          insert into ${journalLines}
            (entry_id, line_index, account_key, account_family, holdings_state, asset_id, asset_scale, direction, amount_base)
          values ('entry-bypass', 0, ${`holdings|available|${TEST_ASSET}`}, 'holdings', 'available', ${TEST_ASSET}, 6, 'debit', 1)
        `);
      }),
    );

    // Deferred to commit, so the single posting is written and then rejected
    // as a whole rather than at the moment it is inserted.
    expect(failure).not.toBeNull();
    expect(describeDriverRefusal(failure)?.code).toBe("UNBALANCED_ENTRY");
    expect(await loadJournalEntries(db)).toHaveLength(0);
  });

  it("refuses an amount with more digits than a base-unit column holds, as a diagnostic — catches a numeric field overflow surfacing as a raw driver error from the middle of a write, which a caller has no reason codes to act on", async () => {
    const tooWide = 10n ** 79n;

    const result = await postJournalEntry(
      db,
      storeEntry("entry-too-wide", "contribution", [
        debitOf(heldIn("available"), tooWide),
        creditOf(counterFamily("contributed-capital"), tooWide),
      ]),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("AMOUNT_OUT_OF_RANGE");
    }
    expect(await loadJournalEntries(db)).toHaveLength(0);
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
