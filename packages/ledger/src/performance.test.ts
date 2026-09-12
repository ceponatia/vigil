import { describe, expect, it } from "vitest";

import { counterAccount, holdingsAccount } from "./accounts";
import { holdingsBase } from "./balances";
import { measurePerformance, type PerformanceMeasure } from "./performance";
import type { EntryKind, JournalEntry } from "./journal";
import {
  sheetFrom,
  twoLineEntry,
  TEST_STABLE_ASSET,
  TEST_VOLATILE_ASSET,
} from "./test-support/journal-fixtures";

// The defect this file kills: measuring drawdown from total equity instead
// of from the cash-flow-adjusted performance series. Under that arithmetic,
// depositing more money erases the drawdown — so a pause keyed on the
// drawdown clears itself at the exact moment the owner has the most capital
// at risk (docs/policy.md, "Cash-flow-adjusted high-water drawdown").

const UNIT = 1_000_000n; // one unit at scale 6
const availableAccount = holdingsAccount(TEST_STABLE_ASSET, "available");
const contributedAccount = counterAccount("contributed-capital", TEST_STABLE_ASSET);
const realizedPnlAccount = counterAccount("realized-pnl", TEST_STABLE_ASSET);
const feesAccount = counterAccount("fees", TEST_STABLE_ASSET);

/** A pause rule stand-in. The real threshold and authority are BOOT-06's. */
const PAUSE_DRAWDOWN_LIMIT = 50n * UNIT;
function pausedByDrawdown(measure: PerformanceMeasure): boolean {
  return measure.drawdownBase >= PAUSE_DRAWDOWN_LIMIT;
}

// 1,000 units in, a 100-unit realized gain, a 4-unit fee, then an 80-unit
// realized loss: the high-water mark is set at +100 and the series ends 84
// below it.
const tradingHistory: readonly JournalEntry[] = [
  twoLineEntry({
    entryId: "entry-initial-funding",
    kind: "contribution",
    debit: availableAccount,
    credit: contributedAccount,
    amountBase: 1_000n * UNIT,
  }),
  twoLineEntry({
    entryId: "entry-realized-gain",
    kind: "realized-pnl",
    debit: availableAccount,
    credit: realizedPnlAccount,
    amountBase: 100n * UNIT,
  }),
  twoLineEntry({
    entryId: "entry-venue-fee",
    kind: "fee",
    debit: feesAccount,
    credit: availableAccount,
    amountBase: 4n * UNIT,
  }),
  twoLineEntry({
    entryId: "entry-realized-loss",
    kind: "realized-pnl",
    debit: realizedPnlAccount,
    credit: availableAccount,
    amountBase: 80n * UNIT,
  }),
];

const deposit = twoLineEntry({
  entryId: "entry-owner-deposit",
  kind: "contribution",
  debit: availableAccount,
  credit: contributedAccount,
  amountBase: 500n * UNIT,
  occurredAt: "2026-02-01T00:00:00.000Z",
  recordedAt: "2026-02-01T00:00:01.000Z",
});

const withdrawal = twoLineEntry({
  entryId: "entry-owner-withdrawal",
  kind: "distribution",
  debit: contributedAccount,
  credit: availableAccount,
  amountBase: 200n * UNIT,
  occurredAt: "2026-02-02T00:00:00.000Z",
  recordedAt: "2026-02-02T00:00:01.000Z",
});

// Both directions of the owner's own money. A deposit and a withdrawal make
// the identical claim on this module — basis moves, performance does not —
// so they are one matrix rather than two near-identical suites.
const cashFlows: ReadonlyArray<{
  name: string;
  entry: JournalEntry;
  kind: EntryKind;
  basisDeltaBase: bigint;
  equityDeltaBase: bigint;
}> = [
  { name: "an owner deposit", entry: deposit, kind: "contribution", basisDeltaBase: 500n * UNIT, equityDeltaBase: 500n * UNIT },
  { name: "an owner withdrawal", entry: withdrawal, kind: "distribution", basisDeltaBase: -200n * UNIT, equityDeltaBase: -200n * UNIT },
];

function measureOrThrow(entries: readonly JournalEntry[]): PerformanceMeasure {
  const result = measurePerformance(entries, TEST_STABLE_ASSET);
  if (result.outcome === "refused") {
    throw new Error(`measure refused: ${result.refusal.reason.code} — ${result.refusal.detail}`);
  }
  return result.measure;
}

describe("measurePerformance", () => {
  it("builds the high-water mark from realized P&L net of fees — catches a measure that ignored fees, which would report a high-water mark the account never actually reached", () => {
    const measure = measureOrThrow(tradingHistory);

    expect(measure.realizedPnlBase).toBe(20n * UNIT);
    expect(measure.feesBase).toBe(4n * UNIT);
    expect(measure.performanceBase).toBe(16n * UNIT);
    // The mark was set at +100, before the fee and the loss that followed it.
    expect(measure.highWaterBase).toBe(100n * UNIT);
    expect(measure.drawdownBase).toBe(84n * UNIT);
    expect(measure.contributedBase).toBe(1_000n * UNIT);
  });

  it.each(cashFlows)(
    "records $name as contributed basis and leaves the drawdown exactly where it was — catches a drawdown measured from equity, which a deposit clears outright and a withdrawal deepens into a pause the owner caused by moving their own money",
    ({ entry, kind, basisDeltaBase, equityDeltaBase }) => {
      const before = measureOrThrow(tradingHistory);
      const withCashFlow = [...tradingHistory, entry];
      const after = measureOrThrow(withCashFlow);

      // The cash flow is basis.
      expect(entry.kind).toBe(kind);
      expect(after.contributedBase).toBe(before.contributedBase + basisDeltaBase);

      // It is not profit, not a loss, and not a recovery.
      expect(after.realizedPnlBase).toBe(before.realizedPnlBase);
      expect(after.feesBase).toBe(before.feesBase);
      expect(after.performanceBase).toBe(before.performanceBase);
      expect(after.highWaterBase).toBe(before.highWaterBase);
      expect(after.drawdownBase).toBe(before.drawdownBase);

      // And the pause a caller keys on that figure neither clears nor
      // tightens, however much capital the owner has just added or removed.
      expect(pausedByDrawdown(before)).toBe(true);
      expect(pausedByDrawdown(after)).toBe(true);

      const equityBefore = holdingsBase(sheetFrom(tradingHistory), TEST_STABLE_ASSET, "available");
      const equityAfter = holdingsBase(sheetFrom(withCashFlow), TEST_STABLE_ASSET, "available");
      expect(equityAfter - equityBefore).toBe(equityDeltaBase);
    },
  );

  it.each(cashFlows)(
    "posts $name only to holdings and contributed capital — catches an owner cash flow routed through the realized-pnl account, which would read as profit or loss for the rest of the account's life",
    ({ entry }) => {
      const families = entry.lines.map((line) => line.account.family).sort();

      expect(families).toEqual(["contributed-capital", "holdings"]);
    },
  );

  it("keeps the high-water mark at a new peak rather than trailing the current value — catches a mark recomputed as the latest performance, which would report zero drawdown forever", () => {
    const measure = measureOrThrow(tradingHistory);

    expect(measure.highWaterBase).toBeGreaterThan(measure.performanceBase);
  });

  it("starts the high-water mark at zero, so a first-ever loss is a drawdown — catches a mark seeded from the first entry, which would treat an opening loss as the baseline and report no drawdown at all", () => {
    const openingLoss = measureOrThrow([
      twoLineEntry({
        entryId: "entry-opening-funding",
        kind: "contribution",
        debit: availableAccount,
        credit: contributedAccount,
        amountBase: 100n * UNIT,
      }),
      twoLineEntry({
        entryId: "entry-opening-loss",
        kind: "realized-pnl",
        debit: realizedPnlAccount,
        credit: availableAccount,
        amountBase: 7n * UNIT,
      }),
    ]);

    expect(openingLoss.performanceBase).toBe(-7n * UNIT);
    expect(openingLoss.highWaterBase).toBe(0n);
    expect(openingLoss.drawdownBase).toBe(7n * UNIT);
  });

  it("refuses to produce a figure from an entry that does not validate, and names the entry — catches a fold that skips a corrupt record and reports the remaining total as if the series were complete", () => {
    // Built by hand, past buildEntry, exactly as a corrupt persisted row
    // would reach the fold.
    const truncated: JournalEntry = { ...deposit, entryId: "entry-truncated", lines: deposit.lines.slice(0, 1) };

    const result = measurePerformance([...tradingHistory, truncated], TEST_STABLE_ASSET);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason).toEqual({ source: "ledger", code: "MALFORMED_ENTRY" });
      expect(result.entryId).toBe("entry-truncated");
    }
  });

  it("measures one asset at a time and never nets two assets together — catches a measure that summed base units across assets, which is an invented exchange rate", () => {
    const stable = measureOrThrow(tradingHistory);
    const unrelated = measurePerformance(tradingHistory, TEST_VOLATILE_ASSET);

    expect(unrelated.outcome).toBe("measured");
    if (unrelated.outcome === "measured") {
      expect(unrelated.measure.performanceBase).toBe(0n);
      expect(unrelated.measure.contributedBase).toBe(0n);
    }
    expect(stable.performanceBase).not.toBe(0n);
  });
});

// Finding 6: the measure summed raw base units across entries with no
// journal-wide scale check of its own.
describe("scale drift", () => {
  it("refuses to measure an asset the journal posts at two scales — catches a sum of base units in no unit at all, from which a drawdown could pause trading that is fine, or fail to pause trading that is not, by orders of magnitude", () => {
    const drifted = measurePerformance(
      [
        twoLineEntry({
          entryId: "entry-pnl-at-six",
          kind: "realized-pnl",
          debit: availableAccount,
          credit: realizedPnlAccount,
          amountBase: 5n * UNIT,
        }),
        twoLineEntry({
          entryId: "entry-pnl-at-eighteen",
          kind: "realized-pnl",
          debit: availableAccount,
          credit: realizedPnlAccount,
          amountBase: 5n * UNIT,
          scale: 18,
        }),
      ],
      TEST_STABLE_ASSET,
    );

    expect(drifted.outcome).toBe("refused");
    if (drifted.outcome === "refused") {
      expect(drifted.refusal.reason.code).toBe("SCALE_MISMATCH");
      expect(drifted.entryId).toBe("entry-pnl-at-eighteen");
    }
  });

  it("ignores a second scale on an asset it was not asked about — catches a check written over the whole journal rather than the measured asset, which would refuse a perfectly good measurement because some unrelated asset uses 18 decimals", () => {
    const measured = measurePerformance(
      [
        ...tradingHistory,
        twoLineEntry({
          entryId: "entry-other-asset",
          kind: "contribution",
          debit: holdingsAccount(TEST_VOLATILE_ASSET, "available"),
          credit: counterAccount("contributed-capital", TEST_VOLATILE_ASSET),
          amountBase: 1n,
          scale: 18,
        }),
      ],
      TEST_STABLE_ASSET,
    );

    expect(measured.outcome).toBe("measured");
  });
});
