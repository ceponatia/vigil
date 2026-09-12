import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { assetScales, journalEntries, journalLines } from "../schema/journal";
import {
  describeDriverRefusal,
  loadBalances,
  loadJournalEntries,
  postJournalEntry,
  type StoreEntry,
} from "./journal-store";
import {
  counterFamily,
  creditOf,
  debitOf,
  fundingEntry,
  heldIn,
  openLedgerTestDb,
  storeEntry,
  TEST_ASSET,
  TEST_PROVENANCE,
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
    expect(await netBaseOf(`holdings/available/${TEST_ASSET}`)).toBe(FUNDED_BASE);
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
    expect(await netBaseOf(`holdings/available/${TEST_ASSET}`)).toBe(FUNDED_BASE - FUNDED_BASE / 4n);
    expect(await netBaseOf(`fees/-/${TEST_ASSET}`)).toBe(FUNDED_BASE / 4n);
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
    expect(await netBaseOf(`holdings/available/${TEST_ASSET}`)).toBe(FUNDED_BASE);
    expect((await loadBalances(db)).map((balance) => balance.accountKey)).not.toContain(`fees/-/${TEST_ASSET}`);
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
          insert into ${assetScales} (asset_id, asset_scale) values (${TEST_ASSET}, 6)
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into ${journalEntries}
            (entry_id, kind, occurred_at, recorded_at, correlation_id, idempotency_key, policy_version, strategy_version)
          values ('entry-bypass', 'contribution', '2026-01-02T03:04:05Z'::timestamptz, '2026-01-02T03:04:06Z'::timestamptz, 'corr-bypass', 'idem-bypass', 'policy-test-0', 'strategy-test-0')
        `);
        await tx.execute(sql`
          insert into ${journalLines}
            (entry_id, line_index, account_key, account_family, holdings_state, asset_id, asset_scale, direction, amount_base)
          values ('entry-bypass', 0, ${`holdings/available/${TEST_ASSET}`}, 'holdings', 'available', ${TEST_ASSET}, 6, 'debit', 1)
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

// Finding 1: 0001 blocked UPDATE and DELETE, leaving INSERT open.
describe("a posted entry is sealed", () => {
  it("refuses postings added to an entry a previous transaction committed, and leaves the projection untouched — catches the third way to rewrite a posted entry: two offsetting lines added later balance under the commit-time guard, change what the entry says, and never reach ledger_balances, so the journal and its projection now disagree about the same money", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-sealed", FUNDED_BASE))).outcome).toBe("posted");
    const balancesBefore = await loadBalances(db);

    const failure = await errorFrom(() =>
      db.execute(sql`
        insert into ${journalLines}
          (entry_id, line_index, account_key, account_family, holdings_state, asset_id, asset_scale, direction, amount_base)
        values
          ('entry-sealed', 2, ${`holdings/reserved/${TEST_ASSET}`}, 'holdings', 'reserved', ${TEST_ASSET}, 6, 'debit', 7),
          ('entry-sealed', 3, ${`holdings/available/${TEST_ASSET}`}, 'holdings', 'available', ${TEST_ASSET}, 6, 'credit', 7)
      `),
    );

    expect(describeDriverRefusal(failure)?.code).toBe("ENTRY_ALREADY_POSTED");
    expect(await loadBalances(db)).toEqual(balancesBefore);
    const lines = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${journalLines} where entry_id = 'entry-sealed'`,
    );
    expect(lines.rows[0]?.count).toBe("2");
  });
});

// Finding 2: one asset, one scale — durably.
describe("asset scale", () => {
  it("refuses an entry that posts one asset at two scales — catches a balance check that groups by asset alone, where a debit of one unit at scale 6 and a credit of one unit at scale 18 cancel out and commit as balanced, though they differ by a factor of a trillion", async () => {
    const mixed: StoreEntry = {
      ...fundingEntry("entry-mixed-scale", 1_000_000n),
      lines: [
        debitOf(heldIn("available"), 1_000_000n),
        { account: counterFamily("contributed-capital"), scale: 18, amountBase: 1_000_000n, direction: "credit" },
      ],
    };

    const result = await postJournalEntry(db, mixed);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("SCALE_MISMATCH");
    }
    expect(await loadJournalEntries(db)).toHaveLength(0);
  });

  it("refuses a later entry that posts a known asset at a new scale, and never mixes scales in the projection — catches a second writer introducing a scale the first never used, after which every balance for that asset is a sum of two different units", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-scale-first", 1_000_000n))).outcome).toBe("posted");

    const atEighteen: StoreEntry = {
      ...fundingEntry("entry-scale-second", 1_000_000n),
      lines: [
        { account: heldIn("available"), scale: 18, amountBase: 1_000_000n, direction: "debit" },
        { account: counterFamily("contributed-capital"), scale: 18, amountBase: 1_000_000n, direction: "credit" },
      ],
    };

    const result = await postJournalEntry(db, atEighteen);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("SCALE_MISMATCH");
    }
    expect(await loadJournalEntries(db)).toHaveLength(1);
    expect(new Set((await loadBalances(db)).map((balance) => balance.assetScale))).toEqual(new Set([6]));
  });

  it("registers each asset's scale exactly once, however many entries post it — catches a registry written per entry, which would either fail on the second posting or quietly hold two rows for one asset", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-register-a", 1_000n))).outcome).toBe("posted");
    expect((await postJournalEntry(db, fundingEntry("entry-register-b", 2_000n))).outcome).toBe("posted");

    const registry = await db.execute<{ asset_id: string; asset_scale: number }>(
      sql`select asset_id, asset_scale from ${assetScales}`,
    );
    expect(registry.rows).toEqual([{ asset_id: TEST_ASSET, asset_scale: 6 }]);
  });
});

// Findings 3 and 10: the store half of the reversal rules.
describe("reversals against durable history", () => {
  function reversalOf(entryId: string, targetId: string, lines: StoreEntry["lines"]): StoreEntry {
    return { ...storeEntry(entryId, "reversal", lines), reversesEntryId: targetId };
  }

  it("refuses a reversal whose postings are not the target's own, inverted — catches a stale caller consuming the target's one correction slot with arbitrary balance changes, after which the real correction can never be posted", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-reversible", FUNDED_BASE))).outcome).toBe("posted");

    const forged = reversalOf("entry-forged-reversal", "entry-reversible", [
      debitOf(counterFamily("fees"), FUNDED_BASE),
      creditOf(heldIn("available"), FUNDED_BASE),
    ]);

    const result = await postJournalEntry(db, forged);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("REVERSAL_NOT_MIRRORED");
    }
    expect(await loadJournalEntries(db)).toHaveLength(1);
  });

  it("accepts the exact inverse of the target — the baseline, so the refusal above is not simply 'no reversal ever posts'", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-correctable", FUNDED_BASE))).outcome).toBe("posted");

    const mirrored = reversalOf("entry-true-reversal", "entry-correctable", [
      creditOf(heldIn("available"), FUNDED_BASE),
      debitOf(counterFamily("contributed-capital"), FUNDED_BASE),
    ]);

    expect((await postJournalEntry(db, mirrored)).outcome).toBe("posted");
    expect(await netBaseOf(`holdings/available/${TEST_ASSET}`)).toBe(0n);
  });

  it("reports a reversal of an entry that is not in durable history as a diagnostic — catches the foreign key surfacing as a raw 23503 crash, which a caller has no reason code to act on", async () => {
    const orphan = reversalOf("entry-orphan-reversal", "entry-never-written", [
      creditOf(heldIn("available"), 1n),
      debitOf(counterFamily("contributed-capital"), 1n),
    ]);

    const result = await postJournalEntry(db, orphan);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("UNKNOWN_REVERSAL_TARGET");
    }
  });
});

// Findings 8, 9 and 4: what the store refuses at the door.
describe("record requirements", () => {
  it("refuses an entry that does not name the policy and strategy versions that produced it — catches a record whose outcome can never be attributed to the behavior that caused it", async () => {
    const unattributed: StoreEntry = {
      ...fundingEntry("entry-unattributed", 1_000n),
      provenance: { ...TEST_PROVENANCE, policyVersion: "  " },
    };

    const result = await postJournalEntry(db, unattributed);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("MISSING_PROVENANCE");
    }
  });

  it("persists the provenance it was given, and reads it back unchanged — catches columns that exist and are never populated, which is the same as not having them", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-attributed", 1_000n))).outcome).toBe("posted");

    const [stored] = await loadJournalEntries(db);
    expect(stored?.provenance).toEqual(TEST_PROVENANCE);
  });

  it("refuses a timestamp finer than the millisecond it can store — catches an event time silently truncated on the way into timestamptz(3), so the record states a time the caller never supplied", async () => {
    const tooPrecise: StoreEntry = { ...fundingEntry("entry-microsecond", 1_000n), occurredAt: "2026-01-02T03:04:05.0004Z" };

    const result = await postJournalEntry(db, tooPrecise);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("MALFORMED_ENTRY");
    }
    expect((await postJournalEntry(db, { ...fundingEntry("entry-millisecond", 1_000n), occurredAt: "2026-01-02T03:04:05.000Z" })).outcome).toBe("posted");
  });

  it("refuses a hold that debits available and credits reserved — the store enforces the same posting shape @vigil/ledger does, because a caller can reach this function without going through the planner; that entry releases another intent's committed funds while every log line reads `reservation-hold`", async () => {
    expect((await postJournalEntry(db, fundingEntry("entry-holds-funds", FUNDED_BASE))).outcome).toBe("posted");

    const inverted = storeEntry("entry-nominal-hold", "reservation-hold", [
      debitOf(heldIn("available"), 10n),
      creditOf(heldIn("reserved"), 10n),
    ]);

    const result = await postJournalEntry(db, inverted);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("RESERVATION_POSTING_SHAPE");
    }
  });
});

// The store shares `@vigil/contracts`' asset-identity schema with the
// ledger now, rather than leaving the `asset_scales` check constraint to
// catch a bad id after a round trip.
describe("asset identity at the door", () => {
  it("refuses a posting to a bare ticker before any write — catches an id that only the database would have rejected, which reaches the caller as a constraint violation instead of a diagnostic naming the asset", async () => {
    const bogus: StoreEntry = {
      ...fundingEntry("entry-ticker", 1_000n),
      lines: [
        { ...debitOf(heldIn("available"), 1_000n), account: { family: "holdings", assetId: "BTC", holdingsState: "available" } },
        {
          ...creditOf(counterFamily("contributed-capital"), 1_000n),
          account: { family: "contributed-capital", assetId: "BTC", holdingsState: null },
        },
      ],
    };

    const result = await postJournalEntry(db, bogus);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("MALFORMED_ENTRY");
      expect(result.detail).toContain("canonical asset id");
    }
    expect(await loadJournalEntries(db)).toHaveLength(0);
  });
});
