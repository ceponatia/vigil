import type { LedgerRefusal } from "./diagnostics";
import { validateEntry, type JournalEntry } from "./journal";

/**
 * Cash-flow-adjusted performance for one asset, in that asset's base units.
 *
 * The distinction this module exists for: **a deposit is basis, not profit.**
 * Owner contributions and withdrawals move `contributedBase` and nothing
 * else. The performance series — and therefore the high-water mark and the
 * drawdown measured from it — is built only from realized P&L and the fees
 * paid to earn it.
 *
 * The bad implementation this shape rules out is the obvious one: measuring
 * drawdown from total equity. Under that arithmetic an 8% drawdown is erased
 * by depositing more money, which would silently release a drawdown pause at
 * the exact moment the owner has the most capital at risk
 * (`docs/policy.md`, "Cash-flow-adjusted high-water drawdown").
 *
 * The pause *decision* is not made here. `packages/policy` owns thresholds
 * and the authority to pause; this package owns only the figure a pause is
 * keyed on, and the guarantee that a contribution does not move it.
 *
 * Figures are per asset and never converted between assets: a numéraire
 * valuation needs market data, which a pure ledger may not have.
 */

export type PerformanceMeasure = {
  readonly assetId: string;
  /** Owner deposits less withdrawals. Basis — never part of performance. */
  readonly contributedBase: bigint;
  /** Realized trading gain; negative on a net realized loss. */
  readonly realizedPnlBase: bigint;
  /** Costs paid to venues, chains, and counterparties. */
  readonly feesBase: bigint;
  /** `realizedPnlBase - feesBase`: the series a drawdown is measured on. */
  readonly performanceBase: bigint;
  /** The highest `performanceBase` the series has reached; never below zero. */
  readonly highWaterBase: bigint;
  /** `highWaterBase - performanceBase`; zero at a new high. */
  readonly drawdownBase: bigint;
};

export type PerformanceResult =
  | { readonly outcome: "measured"; readonly measure: PerformanceMeasure }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal; readonly entryId: string };

/**
 * Fold the journal, in recorded order, into the performance measure for one
 * asset. Entries are re-validated on the way through for the same reason the
 * rebuild validates them: a figure computed from an unbalanced entry is a
 * wrong number presented as a right one.
 */
export function measurePerformance(entries: readonly JournalEntry[], assetId: string): PerformanceResult {
  let contributedBase = 0n;
  let realizedPnlBase = 0n;
  let feesBase = 0n;
  let highWaterBase = 0n;

  for (const entry of entries) {
    const validation = validateEntry(entry);
    if (validation.outcome === "refused") {
      return { outcome: "refused", refusal: validation.refusal, entryId: entry.entryId };
    }

    for (const line of entry.lines) {
      if (line.account.assetId !== assetId) {
        continue;
      }
      const signedCreditNormal = line.direction === "credit" ? line.amountBase : -line.amountBase;
      switch (line.account.family) {
        case "contributed-capital":
          contributedBase += signedCreditNormal;
          break;
        case "realized-pnl":
          realizedPnlBase += signedCreditNormal;
          break;
        case "fees":
          feesBase -= signedCreditNormal;
          break;
        case "holdings":
        case "exchange":
          // Deliberately ignored: where the money sits, and which leg of a
          // swap it came from, says nothing about whether it was earned.
          break;
      }
    }

    const runningPerformance = realizedPnlBase - feesBase;
    if (runningPerformance > highWaterBase) {
      highWaterBase = runningPerformance;
    }
  }

  const performanceBase = realizedPnlBase - feesBase;
  return {
    outcome: "measured",
    measure: {
      assetId,
      contributedBase,
      realizedPnlBase,
      feesBase,
      performanceBase,
      highWaterBase,
      drawdownBase: highWaterBase - performanceBase,
    },
  };
}
