import {
  assetScales,
  createDbClient,
  journalEntries,
  journalLines,
  ledgerBalances,
  loadBalances,
  loadJournalEntries,
  postJournalEntry,
  reservations,
  reserveAvailable,
  type StoreEntry,
  type StoreProvenance,
  type VigilDatabase,
} from "@vigil/db";
import {
  accountKey,
  compareBalanceSheets,
  parseJournalEntry,
  rebuildBalances,
  type AccountBalance,
  type BalanceSheet,
  type JournalEntry,
} from "@vigil/ledger";
import { assetIdSchema } from "@vigil/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Acceptance scenario: restarting from an empty runtime state rebuilds
// balances that match the journal exactly (issue #6, BOOT-04).
//
// The defect this kills is the one a restart is most likely to hide: a
// rebuild that produces a *plausible* balance sheet rather than an identical
// one — dropping a reversal, missing the reserved side of a hold, or netting
// two assets together — and a process that then trades on it.
//
// Both packages are exercised through their declared exports only: the layer
// graph forbids @vigil/db and @vigil/ledger from importing each other, so
// this suite is where their agreement is actually proved.

const client = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  applicationName: "vigil-replay-test",
});
const db: VigilDatabase = client.db;

/**
 * Every account the history below touches: available and reserved stable,
 * available volatile, the stable and volatile exchange clearing accounts,
 * contributed capital, fees, and realized P&L. Pinned exactly, because a
 * rebuild that quietly invents or drops an account is the defect this suite
 * exists to catch.
 */
const EXPECTED_ACCOUNTS = 8;

/** Synthetic provenance: every record says what produced it. */
const REPLAY_PROVENANCE: StoreProvenance = {
  policyVersion: "policy-replay-0",
  strategyVersion: "strategy-replay-0",
  modelVersion: null,
  portfolioSnapshotVersion: "portfolio-replay-0",
  marketSnapshotVersion: "market-replay-0",
};

const STABLE = assetIdSchema.parse("1337|native|VGLSTABLE|SYNTHETIC_TESTNET");
const STABLE_SCALE = 6;
const VOLATILE = assetIdSchema.parse("1337|native|VGLVOLATILE|SYNTHETIC_TESTNET");
const VOLATILE_SCALE = 18;

function line(
  family: "holdings" | "contributed-capital" | "realized-pnl" | "fees" | "exchange",
  holdingsState: "available" | "reserved" | null,
  assetId: string,
  scale: number,
  direction: "debit" | "credit",
  amountBase: bigint,
): StoreEntry["lines"][number] {
  return { account: { family, assetId, holdingsState }, scale, amountBase, direction };
}

function entry(
  entryId: string,
  kind: StoreEntry["kind"],
  recordedAt: string,
  lines: StoreEntry["lines"],
  reversesEntryId: string | null = null,
): StoreEntry {
  return {
    entryId,
    kind,
    occurredAt: recordedAt,
    recordedAt,
    correlationId: `corr-${entryId}`,
    idempotencyKey: `idem-${entryId}`,
    intentId: null,
    reversesEntryId,
    provenance: REPLAY_PROVENANCE,
    lines,
  };
}

// A deliberately awkward history: two assets at different scales, a swap
// that balances per asset through the exchange clearing account, a fee, a
// realized loss, a hold taken through the reservation path, and a correction
// posted as a reversal.
const history: readonly StoreEntry[] = [
  entry("replay-fund-stable", "contribution", "2026-03-01T00:00:00.000Z", [
    line("holdings", "available", STABLE, STABLE_SCALE, "debit", 1_000_000_000n),
    line("contributed-capital", null, STABLE, STABLE_SCALE, "credit", 1_000_000_000n),
  ]),
  entry("replay-swap", "trade", "2026-03-01T00:01:00.000Z", [
    line("holdings", "available", STABLE, STABLE_SCALE, "credit", 100_000_000n),
    line("exchange", null, STABLE, STABLE_SCALE, "debit", 100_000_000n),
    line("holdings", "available", VOLATILE, VOLATILE_SCALE, "debit", 2_500_000_000_000_000_000n),
    line("exchange", null, VOLATILE, VOLATILE_SCALE, "credit", 2_500_000_000_000_000_000n),
  ]),
  entry("replay-fee", "fee", "2026-03-01T00:02:00.000Z", [
    line("fees", null, STABLE, STABLE_SCALE, "debit", 2_500_000n),
    line("holdings", "available", STABLE, STABLE_SCALE, "credit", 2_500_000n),
  ]),
  entry("replay-fee-correction", "reversal", "2026-03-01T00:03:00.000Z", [
    line("fees", null, STABLE, STABLE_SCALE, "credit", 2_500_000n),
    line("holdings", "available", STABLE, STABLE_SCALE, "debit", 2_500_000n),
  ], "replay-fee"),
  entry("replay-fee-corrected", "fee", "2026-03-01T00:04:00.000Z", [
    line("fees", null, STABLE, STABLE_SCALE, "debit", 1_500_000n),
    line("holdings", "available", STABLE, STABLE_SCALE, "credit", 1_500_000n),
  ]),
  entry("replay-realized-loss", "realized-pnl", "2026-03-01T00:05:00.000Z", [
    line("realized-pnl", null, STABLE, STABLE_SCALE, "debit", 40_000_000n),
    line("exchange", null, STABLE, STABLE_SCALE, "credit", 40_000_000n),
  ]),
];

function toBalanceSheet(
  rows: ReadonlyArray<{
    accountKey: string;
    accountFamily: AccountBalance["account"]["family"];
    holdingsState: AccountBalance["account"]["holdingsState"];
    assetId: string;
    assetScale: number;
    debitBase: bigint;
    creditBase: bigint;
  }>,
): BalanceSheet {
  return new Map(
    rows.map((row): [string, AccountBalance] => [
      row.accountKey,
      {
        account: { family: row.accountFamily, assetId: row.assetId, holdingsState: row.holdingsState },
        scale: row.assetScale,
        debitBase: row.debitBase,
        creditBase: row.creditBase,
      },
    ]),
  );
}

function replayed(entries: readonly StoreEntry[]): readonly JournalEntry[] {
  return entries.map((stored) => {
    const parsed = parseJournalEntry(stored);
    if (parsed.outcome === "refused") {
      throw new Error(`persisted entry ${stored.entryId} did not parse: ${parsed.refusal.reason.code}`);
    }
    return parsed.entry;
  });
}

beforeAll(async () => {
  await db.execute(
    sql`truncate table ${reservations}, ${journalLines}, ${journalEntries}, ${ledgerBalances}, ${assetScales} restart identity cascade`,
  );

  for (const record of history) {
    const posted = await postJournalEntry(db, record);
    expect(posted.outcome).toBe("posted");
  }

  const held = await reserveAvailable(db, {
    reservationId: "replay-reservation",
    intentId: "replay-intent",
    attempt: 1,
    idempotencyKey: "idem-replay-reservation",
    correlationId: "corr-replay-reservation",
    entryId: "replay-hold",
    assetId: STABLE,
    scale: STABLE_SCALE,
    amountBase: 300_000_000n,
    occurredAt: "2026-03-01T00:06:00.000Z",
    recordedAt: "2026-03-01T00:06:01.000Z",
    expiresAt: "2026-03-01T00:11:00.000Z",
    provenance: REPLAY_PROVENANCE,
  });
  expect(held.outcome).toBe("reserved");
});

afterAll(async () => {
  await client.close();
});

describe("rebuilding balances from the journal alone", () => {
  it("reproduces the persisted balance projection exactly, from an empty runtime state — catches a rebuild that agrees on the net while disagreeing on what happened, and any projection written outside the journal that replay cannot reproduce", async () => {
    const stored = await loadBalances(db);
    const persisted = toBalanceSheet(stored);

    const rebuilt = rebuildBalances(replayed(await loadJournalEntries(db)));

    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") {
      return;
    }

    // Non-vacuous: a rebuild of nothing would also report no differences.
    expect(rebuilt.entryCount).toBe(history.length + 1);
    expect(rebuilt.balances.size).toBe(EXPECTED_ACCOUNTS);
    expect(persisted.size).toBe(rebuilt.balances.size);

    expect(compareBalanceSheets(rebuilt.balances, persisted)).toEqual([]);
  });

  it("reports a difference when the replay is one posted entry short, and refuses a replay that reads one twice — catches a comparison that would report agreement whatever the rebuild did with these rows, which is the only way the assertion above can pass while the rebuild is wrong", async () => {
    const persisted = toBalanceSheet(await loadBalances(db));
    const entries = replayed(await loadJournalEntries(db));
    expect(entries.length).toBeGreaterThan(1);

    const dropped = rebuildBalances(entries.slice(0, -1));
    expect(dropped.outcome).toBe("rebuilt");
    if (dropped.outcome === "rebuilt") {
      expect(compareBalanceSheets(dropped.balances, persisted)).not.toEqual([]);
    }

    // Double-counting cannot even produce a sheet: an overlapping read is
    // refused rather than folded in twice.
    const doubled = rebuildBalances([...entries, ...entries.slice(-1)]);
    expect(doubled.outcome).toBe("refused");
    if (doubled.outcome === "refused") {
      expect(doubled.refusal.reason.code).toBe("DUPLICATE_ENTRY_ID");
    }
  });

  it("keeps each asset at its own scale through the rebuild — catches a replay that reads one scale for every asset, which would misprice an 18-decimal balance by twelve orders of magnitude", async () => {
    const rebuilt = rebuildBalances(replayed(await loadJournalEntries(db)));
    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") {
      return;
    }

    const stableAvailable = rebuilt.balances.get(
      accountKey({ family: "holdings", assetId: STABLE, holdingsState: "available" }),
    );
    const volatileAvailable = rebuilt.balances.get(
      accountKey({ family: "holdings", assetId: VOLATILE, holdingsState: "available" }),
    );

    expect(stableAvailable?.scale).toBe(STABLE_SCALE);
    expect(volatileAvailable?.scale).toBe(VOLATILE_SCALE);
    expect(volatileAvailable?.debitBase).toBe(2_500_000_000_000_000_000n);
  });

  it("shows the reservation in the rebuilt balances, not only in the reservations table — catches a hold recorded as a row with no accounting behind it, which a restart would lose", async () => {
    const rebuilt = rebuildBalances(replayed(await loadJournalEntries(db)));
    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") {
      return;
    }

    const reserved = rebuilt.balances.get(
      accountKey({ family: "holdings", assetId: STABLE, holdingsState: "reserved" }),
    );

    expect(reserved?.debitBase).toBe(300_000_000n);
  });
});
