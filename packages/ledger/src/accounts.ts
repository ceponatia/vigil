import { z } from "zod";

import { ledgerRefusal, policyRefusal, type LedgerRefusal } from "./diagnostics";

/**
 * The six holdings states from `docs/product.md` TASK-07 — "available,
 * reserved, staked, unbonding, pending-transfer, and exit-queued balances
 * are distinct". They are distinct values here, and a constrained column in
 * `packages/db`, before anything populates the last four: the defect this
 * prevents is a later slice discovering only `available`/`reserved` exist
 * and folding a staked balance into spendable cash to make its code compile.
 */
export const HOLDINGS_STATES = [
  "available",
  "reserved",
  "staked",
  "unbonding",
  "pending-transfer",
  "exit-queued",
] as const;

export type HoldingsState = (typeof HOLDINGS_STATES)[number];

export const holdingsStateSchema = z.enum(HOLDINGS_STATES);

/**
 * The account families a posting can touch.
 *
 * `holdings` is the only family that holds an asset the application can
 * spend, and the only one carrying a holdings state. The rest are the
 * counter-accounts that make a multi-asset entry balance:
 *
 * | Family                | Normal side | What a non-zero balance means                     |
 * | --------------------- | ----------- | ------------------------------------------------- |
 * | `holdings`            | debit       | the application holds this much of the asset      |
 * | `contributed-capital` | credit      | owner basis put in (deposits less withdrawals)    |
 * | `realized-pnl`        | credit      | realized trading gain (negative: realized loss)   |
 * | `fees`                | debit       | cost paid to venues, chains, and counterparties   |
 * | `exchange`            | credit      | the asset legs of a swap, awaiting P&L recognition |
 *
 * `exchange` is what keeps the balancing invariant per asset rather than in
 * a numéraire: selling 100 USDC for 0.001 BTC does not balance across two
 * different assets, so each leg balances against this clearing account and
 * the P&L recognition that clears it is its own, separately reviewable
 * entry. Valuing one asset in another needs market data, which this package
 * is not allowed to have.
 */
export const ACCOUNT_FAMILIES = [
  "holdings",
  "contributed-capital",
  "realized-pnl",
  "fees",
  "exchange",
] as const;

export type AccountFamily = (typeof ACCOUNT_FAMILIES)[number];

export const accountFamilySchema = z.enum(ACCOUNT_FAMILIES);

export const POSTING_DIRECTIONS = ["debit", "credit"] as const;

export type PostingDirection = (typeof POSTING_DIRECTIONS)[number];

export const postingDirectionSchema = z.enum(POSTING_DIRECTIONS);

/**
 * Which side increases each family. Every stored balance is kept as the
 * mechanical `debits - credits` so a rebuild needs no per-family rule; this
 * registry is what turns that raw net into a figure a human reads the right
 * way round.
 */
export const ACCOUNT_FAMILY_NORMAL_SIDE: Readonly<Record<AccountFamily, PostingDirection>> = {
  holdings: "debit",
  "contributed-capital": "credit",
  "realized-pnl": "credit",
  fees: "debit",
  exchange: "credit",
};

/**
 * Whether a reservation may be taken from a holdings state, and the refusal
 * when it may not. A reservation consumes only `available`
 * (`docs/architecture.md`: the allocator is the only path to a reservation,
 * and two strategies never reserve the same capital).
 *
 * `staked`, `unbonding`, and `exit-queued` are exactly what `YIELD_LOCKED`
 * already names in `docs/policy.md`, so they refuse with that policy code.
 * `reserved` and `pending-transfer` are not locked yield — one is already
 * committed to another intent, the other is in flight between locations —
 * so they refuse with a ledger diagnostic rather than borrowing a policy
 * code that would tell an operator the wrong story.
 */
export type StateReservability =
  | { readonly reservable: true }
  | { readonly reservable: false; readonly refusal: LedgerRefusal };

export const HOLDINGS_STATE_RESERVABILITY: Readonly<Record<HoldingsState, StateReservability>> = {
  available: { reservable: true },
  reserved: {
    reservable: false,
    refusal: ledgerRefusal("STATE_NOT_RESERVABLE", "reserved funds are already committed to another intent"),
  },
  staked: {
    reservable: false,
    refusal: policyRefusal("YIELD_LOCKED", "staked funds are not available to reserve"),
  },
  unbonding: {
    reservable: false,
    refusal: policyRefusal("YIELD_LOCKED", "unbonding funds are not available to reserve"),
  },
  "pending-transfer": {
    reservable: false,
    refusal: ledgerRefusal("STATE_NOT_RESERVABLE", "funds in transit between locations are not spendable inventory"),
  },
  "exit-queued": {
    reservable: false,
    refusal: policyRefusal("YIELD_LOCKED", "exit-queued funds are not available to reserve"),
  },
};

/**
 * A canonical asset id: chain plus contract/mint or native denomination,
 * never a bare ticker (`AGENTS.md` "Financial authority and safety"). This
 * package does not resolve identity, it only refuses to key an account on a
 * string that cannot be a canonical id or that would make an account key
 * ambiguous — `|` is the key separator, so it is excluded here.
 *
 * Seam: `packages/contracts`'s asset-identity module owns this vocabulary
 * once it lands, and `assetId` becomes its type instead of a local string.
 */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const assetIdSchema = z.string().regex(ASSET_ID_PATTERN, {
  error: "expected a canonical asset id: no whitespace, no control characters, no '|'",
});

export type LedgerAccount = {
  readonly family: AccountFamily;
  readonly assetId: string;
  /** Non-null exactly when `family` is `holdings`. */
  readonly holdingsState: HoldingsState | null;
};

export const ledgerAccountSchema = z
  .object({
    family: accountFamilySchema,
    assetId: assetIdSchema,
    holdingsState: holdingsStateSchema.nullable(),
  })
  .superRefine((account, ctx) => {
    const isHoldings = account.family === "holdings";
    if (isHoldings && account.holdingsState === null) {
      ctx.addIssue({ code: "custom", message: "a holdings account must name one of the six holdings states" });
    }
    if (!isHoldings && account.holdingsState !== null) {
      ctx.addIssue({ code: "custom", message: `a ${account.family} account carries no holdings state` });
    }
  });

export function holdingsAccount(assetId: string, holdingsState: HoldingsState): LedgerAccount {
  return { family: "holdings", assetId, holdingsState };
}

export function counterAccount(family: Exclude<AccountFamily, "holdings">, assetId: string): LedgerAccount {
  return { family, assetId, holdingsState: null };
}

/**
 * The stable string a balance row is keyed by, in both the rebuilt map and
 * the `ledger_balances` table. Injective because `|` cannot appear in a
 * family, a state, or an asset id.
 */
export function accountKey(account: LedgerAccount): string {
  return `${account.family}|${account.holdingsState ?? "-"}|${account.assetId}`;
}
