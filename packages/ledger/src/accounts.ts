import { assetIdSchema, type AssetId } from "@vigil/contracts";
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
 * Which code each refusal carries is an owner ruling (2026-09-12), because
 * a reason code is what an operator reads when funds they expected to be
 * spendable are not:
 *
 * - `staked` and `unbonding` are exactly what `YIELD_LOCKED` names in
 *   `docs/policy.md`.
 * - `pending-transfer` funds are in flight between controlled locations, so
 *   they carry `TRANSACTION_UNRESOLVED` — the approved code for a prior
 *   transaction whose outcome still blocks action on the same funds.
 * - `exit-queued` funds are committed to an exit that has been requested and
 *   not completed. That is not necessarily a yield lock: an exchange
 *   withdrawal queue is one too. It carries the ledger-local
 *   `STATE_NOT_RESERVABLE` with a detail naming the state, rather than
 *   telling an operator a story about staking that may not be true.
 * - `reserved` funds are already committed to another intent — an
 *   accounting fact, not a policy decision — so it is ledger-local as well.
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
    refusal: policyRefusal(
      "TRANSACTION_UNRESOLVED",
      "funds in transit between locations are not spendable inventory until the transfer resolves",
    ),
  },
  "exit-queued": {
    reservable: false,
    refusal: ledgerRefusal(
      "STATE_NOT_RESERVABLE",
      "exit-queued funds are committed to a requested exit and are not available to reserve",
    ),
  },
};

/**
 * The separator between an account key's components.
 *
 * `/` rather than `|`: a canonical asset id contains three `|` of its own,
 * so a `|`-joined key could not be split back into its parts, while `/` is
 * forbidden inside every component of an asset identity. The key stays
 * injective *and* readable — `holdings/available/1|native|ETH|mainnet`
 * splits at the first two separators and the remainder is the asset id.
 */
export const ACCOUNT_KEY_SEPARATOR = "/";

/**
 * Asset identity comes from `@vigil/contracts`: `AssetId` is the branded,
 * canonical `chainId|kind|value|withdrawalNetwork` string that
 * `canonicalAssetId` derives, and `assetIdSchema` is the only way to hold
 * one. This package used to restate that shape as a local pattern; it no
 * longer does, so a ledger account and a market quote are keyed by the same
 * type rather than by two spellings of it.
 *
 * The rule it enforces has not changed: a bare ticker is not an identity.
 * `BTC` names a different asset on every chain that lists something by that
 * symbol, and two of them sharing an account would merge two positions into
 * one balance that reconciles against neither venue (`docs/testing.md`,
 * "Chain/contract/mint differs despite a matching ticker").
 */

export type LedgerAccount = {
  readonly family: AccountFamily;
  readonly assetId: AssetId;
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

export function holdingsAccount(assetId: AssetId, holdingsState: HoldingsState): LedgerAccount {
  return { family: "holdings", assetId, holdingsState };
}

export function counterAccount(family: Exclude<AccountFamily, "holdings">, assetId: AssetId): LedgerAccount {
  return { family, assetId, holdingsState: null };
}

/**
 * The stable string a balance row is keyed by, in both the rebuilt map and
 * the `ledger_balances` table.
 *
 * Injective: the first two components come from closed vocabularies that
 * contain no `/`, and a canonical asset id may not contain one either, so
 * exactly two separators precede the asset id and no two distinct accounts
 * can derive the same key.
 */
export function accountKey(account: LedgerAccount): string {
  const state = account.holdingsState ?? "-";
  return `${account.family}${ACCOUNT_KEY_SEPARATOR}${state}${ACCOUNT_KEY_SEPARATOR}${account.assetId}`;
}
