import { accountKey, type HoldingsState, type LedgerAccount } from "./accounts";
import { ledgerRefusal, type LedgerDiagnosticCode, type LedgerRefusal } from "./diagnostics";
import { validateEntry, type JournalEntry } from "./journal";

/**
 * Balances are a projection of the journal, never an independent record.
 *
 * Each account accumulates its debit and credit totals separately, as
 * non-negative, monotonically increasing figures. Two consequences the
 * application depends on:
 *
 * - The net (`debits - credits`) is a mechanical rule with no per-family
 *   special case, so a rebuild from the journal alone cannot disagree with
 *   the stored projection about what a balance means.
 * - `packages/db` can express "a holdings account may never go negative" as
 *   a single check constraint over two columns, which is what makes the
 *   concurrent-overspend guarantee durable rather than advisory.
 */

export type AccountBalance = {
  readonly account: LedgerAccount;
  readonly scale: number;
  readonly debitBase: bigint;
  readonly creditBase: bigint;
};

/** Keyed by `accountKey(account)`. */
export type BalanceSheet = ReadonlyMap<string, AccountBalance>;

export type RebuildResult =
  | { readonly outcome: "rebuilt"; readonly balances: BalanceSheet; readonly entryCount: number }
  | { readonly outcome: "refused"; readonly refusal: LedgerRefusal; readonly entryId: string | null };

function rebuildRefusal(code: LedgerDiagnosticCode, detail: string, entryId: string | null): RebuildResult {
  return { outcome: "refused", refusal: ledgerRefusal(code, detail), entryId };
}

/**
 * Rebuild every balance from the journal, starting from nothing.
 *
 * This is the restart path: a process that comes up with no runtime state
 * replays the journal and must arrive at exactly the balances that were
 * persisted before it went down. Every entry is re-validated on the way
 * through, so a corrupt or unbalanced row is a refusal with the offending
 * entry id rather than a silently wrong opening balance.
 *
 * `entries` must be in journal order (the order they were recorded).
 */
export function rebuildBalances(entries: readonly JournalEntry[]): RebuildResult {
  const balances = new Map<string, AccountBalance>();
  const seenEntryIds = new Set<string>();
  const seenIdempotencyKeys = new Set<string>();
  const reversedEntryIds = new Set<string>();
  const scaleByAsset = new Map<string, number>();

  for (const entry of entries) {
    const validation = validateEntry(entry);
    if (validation.outcome === "refused") {
      return { outcome: "refused", refusal: validation.refusal, entryId: entry.entryId };
    }

    if (seenEntryIds.has(entry.entryId)) {
      return rebuildRefusal("DUPLICATE_ENTRY_ID", `entry ${entry.entryId} appears twice in the replayed journal`, entry.entryId);
    }
    seenEntryIds.add(entry.entryId);

    if (seenIdempotencyKeys.has(entry.idempotencyKey)) {
      return rebuildRefusal(
        "DUPLICATE_IDEMPOTENCY_KEY",
        `idempotency key ${entry.idempotencyKey} appears twice in the replayed journal`,
        entry.entryId,
      );
    }
    seenIdempotencyKeys.add(entry.idempotencyKey);

    if (entry.reversesEntryId !== null) {
      const target = entry.reversesEntryId;
      if (!seenEntryIds.has(target)) {
        return rebuildRefusal("UNKNOWN_REVERSAL_TARGET", `entry ${target} is not in the replayed journal`, entry.entryId);
      }
      if (reversedEntryIds.has(target)) {
        return rebuildRefusal("DUPLICATE_REVERSAL", `entry ${target} is reversed twice in the replayed journal`, entry.entryId);
      }
      reversedEntryIds.add(target);
    }

    for (const line of entry.lines) {
      const knownScale = scaleByAsset.get(line.account.assetId);
      if (knownScale === undefined) {
        scaleByAsset.set(line.account.assetId, line.scale);
      } else if (knownScale !== line.scale) {
        return rebuildRefusal(
          "SCALE_MISMATCH",
          `asset ${line.account.assetId} is posted at scale ${String(knownScale)} and scale ${String(line.scale)}`,
          entry.entryId,
        );
      }

      const key = accountKey(line.account);
      const current = balances.get(key) ?? {
        account: line.account,
        scale: line.scale,
        debitBase: 0n,
        creditBase: 0n,
      };
      balances.set(key, {
        account: current.account,
        scale: current.scale,
        debitBase: current.debitBase + (line.direction === "debit" ? line.amountBase : 0n),
        creditBase: current.creditBase + (line.direction === "credit" ? line.amountBase : 0n),
      });
    }
  }

  return { outcome: "rebuilt", balances, entryCount: entries.length };
}

/** Debits less credits. Positive on a debit-normal account that holds value. */
export function netBase(balance: AccountBalance): bigint {
  return balance.debitBase - balance.creditBase;
}

export function balanceOf(balances: BalanceSheet, account: LedgerAccount): AccountBalance | null {
  return balances.get(accountKey(account)) ?? null;
}

/** Net base units held in one holdings state; zero when the account has no postings. */
export function holdingsBase(balances: BalanceSheet, assetId: string, state: HoldingsState): bigint {
  const balance = balances.get(accountKey({ family: "holdings", assetId, holdingsState: state }));
  return balance === undefined ? 0n : netBase(balance);
}

export type BalanceDifference = {
  readonly accountKey: string;
  readonly expectedNetBase: bigint | null;
  readonly actualNetBase: bigint | null;
};

/**
 * Every account where two balance sheets disagree, including accounts
 * present in only one of them. An empty result is the reconciliation
 * assertion: the rebuilt projection and the stored projection are the same
 * statement about the same money.
 */
export function compareBalanceSheets(expected: BalanceSheet, actual: BalanceSheet): readonly BalanceDifference[] {
  const differences: BalanceDifference[] = [];
  const keys = new Set<string>([...expected.keys(), ...actual.keys()]);

  for (const key of [...keys].sort()) {
    const left = expected.get(key);
    const right = actual.get(key);
    const leftNet = left === undefined ? null : netBase(left);
    const rightNet = right === undefined ? null : netBase(right);
    const sameTotals =
      left !== undefined &&
      right !== undefined &&
      left.debitBase === right.debitBase &&
      left.creditBase === right.creditBase &&
      left.scale === right.scale;
    if (!sameTotals) {
      differences.push({ accountKey: key, expectedNetBase: leftNet, actualNetBase: rightNet });
    }
  }

  return differences;
}
