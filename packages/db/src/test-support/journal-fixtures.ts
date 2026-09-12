import type { AccountFamilyValue, HoldingsStateValue, JournalEntryKindValue } from "../schema/journal";
import type { StoreAccount, StoreEntry, StoreLine } from "../store/journal-store";

/**
 * Record builders for this package's own integration suites. Never imported
 * by production code and never exported from `src/index.ts`.
 *
 * Asset ids are `test:`-prefixed and cannot be a real chain-plus-contract
 * identity; no address, key, or holding appears here.
 */

export const TEST_ASSET = "test:stable-6";
export const TEST_SCALE = 6;

export function heldIn(holdingsState: HoldingsStateValue): StoreAccount {
  return { family: "holdings", assetId: TEST_ASSET, holdingsState };
}

export function counterFamily(family: Exclude<AccountFamilyValue, "holdings">): StoreAccount {
  return { family, assetId: TEST_ASSET, holdingsState: null };
}

export function debitOf(account: StoreAccount, amountBase: bigint): StoreLine {
  return { account, scale: TEST_SCALE, amountBase, direction: "debit" };
}

export function creditOf(account: StoreAccount, amountBase: bigint): StoreLine {
  return { account, scale: TEST_SCALE, amountBase, direction: "credit" };
}

export function storeEntry(
  entryId: string,
  kind: JournalEntryKindValue,
  lines: readonly StoreLine[],
  recordedAt = "2026-01-02T03:04:06.000Z",
): StoreEntry {
  return {
    entryId,
    kind,
    occurredAt: "2026-01-02T03:04:05.000Z",
    recordedAt,
    correlationId: `corr-${entryId}`,
    idempotencyKey: `idem-${entryId}`,
    intentId: null,
    reversesEntryId: null,
    lines,
  };
}

/** A synthetic owner deposit: basis in, posted to available. */
export function fundingEntry(entryId: string, amountBase: bigint): StoreEntry {
  return storeEntry(entryId, "contribution", [
    debitOf(heldIn("available"), amountBase),
    creditOf(counterFamily("contributed-capital"), amountBase),
  ]);
}
