import { describe, expect, it } from "vitest";

import {
  accountKey,
  counterAccount,
  holdingsAccount,
  ledgerAccountSchema,
  ACCOUNT_FAMILIES,
  HOLDINGS_STATES,
  type LedgerAccount,
} from "./accounts";
import { buildEntry } from "./journal";
import { at, TEST_STABLE_ASSET, TEST_STABLE_SCALE } from "./test-support/journal-fixtures";

// The defect this file kills: an account whose holdings state is optional
// rather than paired to its family. A holdings account with no state keys as
// `holdings|-|asset`, which is a different `ledger_balances` row from
// `holdings|available|asset` — so one spendable balance splits in two, and
// the `ledger_balances_holdings_never_negative` constraint compares halves
// of it against each other. packages/db refuses the same pairing with the
// `journal_lines_holdings_state` check; this is the half that refuses it
// before a row is ever on its way to Postgres.

const statelessHoldings: LedgerAccount = {
  family: "holdings",
  assetId: TEST_STABLE_ASSET,
  holdingsState: null,
};
const statefulCounter: LedgerAccount = {
  family: "contributed-capital",
  assetId: TEST_STABLE_ASSET,
  holdingsState: "available",
};

describe("ledgerAccountSchema", () => {
  it("pairs the holdings state to the family in both directions — catches a state left optional, where a holdings account with no state becomes a second, invisible balance for the same asset", () => {
    expect(ledgerAccountSchema.safeParse(statelessHoldings).success).toBe(false);
    expect(ledgerAccountSchema.safeParse(statefulCounter).success).toBe(false);

    // Non-vacuous: a schema that rejected everything would pass the two
    // cases above and tell us nothing.
    expect(ledgerAccountSchema.safeParse(holdingsAccount(TEST_STABLE_ASSET, "available")).success).toBe(true);
    expect(ledgerAccountSchema.safeParse(counterAccount("contributed-capital", TEST_STABLE_ASSET)).success).toBe(true);
  });

  it("refuses an entry carrying such a line instead of leaving the pairing to the database — catches an account schema declared but never wired into the posting path, where the rule holds only for writes that reach Postgres and not for a rebuild or a replay", () => {
    const built = buildEntry({
      entryId: "entry-stateless-holdings",
      kind: "contribution",
      occurredAt: at("2026-01-02T03:04:05.000Z"),
      recordedAt: at("2026-01-02T03:04:06.000Z"),
      correlationId: "corr-stateless-holdings",
      idempotencyKey: "idem-stateless-holdings",
      lines: [
        { account: statelessHoldings, scale: TEST_STABLE_SCALE, amountBase: 1n, direction: "debit" },
        {
          account: counterAccount("contributed-capital", TEST_STABLE_ASSET),
          scale: TEST_STABLE_SCALE,
          amountBase: 1n,
          direction: "credit",
        },
      ],
    });

    expect(built.outcome).toBe("refused");
    if (built.outcome === "refused") {
      expect(built.refusal.reason).toEqual({ source: "ledger", code: "MALFORMED_ENTRY" });
    }
  });
});

describe("accountKey", () => {
  // Registry-derived: a family or state added later is keyed here without
  // anyone remembering to extend a case list.
  it("gives every family-and-state combination the vocabulary allows its own key — catches a separator or null placeholder that lets two distinct accounts share one ledger_balances row, where one account's credits would net against another's debits", () => {
    const accounts: readonly LedgerAccount[] = ACCOUNT_FAMILIES.flatMap((family) =>
      family === "holdings"
        ? HOLDINGS_STATES.map((holdingsState) => holdingsAccount(TEST_STABLE_ASSET, holdingsState))
        : [counterAccount(family, TEST_STABLE_ASSET)],
    );

    expect(accounts).toHaveLength(HOLDINGS_STATES.length + ACCOUNT_FAMILIES.length - 1);
    expect(new Set(accounts.map((account) => accountKey(account))).size).toBe(accounts.length);
  });
});
