import { describe, expect, it } from "vitest";

import { counterAccount, holdingsAccount } from "./accounts";
import { holdingsBase } from "./balances";
import { measurePerformance, type PerformanceMeasure } from "./performance";
import type { JournalEntry } from "./journal";
import { sheetFrom, twoLineEntry, TEST_STABLE_ASSET } from "./test-support/journal-fixtures";

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

  it("records an owner deposit as contributed basis and leaves the drawdown exactly where it was — catches a drawdown measured from equity, which this deposit would clear outright", () => {
    const before = measureOrThrow(tradingHistory);
    const withDeposit = [...tradingHistory, deposit];
    const after = measureOrThrow(withDeposit);

    // The deposit is basis.
    expect(deposit.kind).toBe("contribution");
    expect(after.contributedBase).toBe(before.contributedBase + 500n * UNIT);

    // It is not profit, and it is not a recovery.
    expect(after.realizedPnlBase).toBe(before.realizedPnlBase);
    expect(after.feesBase).toBe(before.feesBase);
    expect(after.performanceBase).toBe(before.performanceBase);
    expect(after.highWaterBase).toBe(before.highWaterBase);
    expect(after.drawdownBase).toBe(before.drawdownBase);

    // And the pause a caller keys on that figure does not clear, even though
    // the account now holds 500 more units than it did while paused.
    expect(pausedByDrawdown(before)).toBe(true);
    expect(pausedByDrawdown(after)).toBe(true);

    const equityBefore = holdingsBase(sheetFrom(tradingHistory), TEST_STABLE_ASSET, "available");
    const equityAfter = holdingsBase(sheetFrom(withDeposit), TEST_STABLE_ASSET, "available");
    expect(equityAfter - equityBefore).toBe(500n * UNIT);
  });

  it("posts a deposit only to holdings and contributed capital — catches a deposit routed through the realized-pnl account, which would read as profit for the rest of the account's life", () => {
    const families = deposit.lines.map((line) => line.account.family).sort();

    expect(families).toEqual(["contributed-capital", "holdings"]);
  });

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

  it("measures one asset at a time and never nets two assets together — catches a measure that summed base units across assets, which is an invented exchange rate", () => {
    const stable = measureOrThrow(tradingHistory);
    const unrelated = measurePerformance(tradingHistory, "test:volatile-18");

    expect(unrelated.outcome).toBe("measured");
    if (unrelated.outcome === "measured") {
      expect(unrelated.measure.performanceBase).toBe(0n);
      expect(unrelated.measure.contributedBase).toBe(0n);
    }
    expect(stable.performanceBase).not.toBe(0n);
  });
});
