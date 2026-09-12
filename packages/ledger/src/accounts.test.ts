import { assetIdSchema } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import {
  accountKey,
  counterAccount,
  holdingsAccount,
  ledgerAccountSchema,
  ACCOUNT_FAMILIES,
  ACCOUNT_KEY_SEPARATOR,
  HOLDINGS_STATES,
  type LedgerAccount,
} from "./accounts";
import { buildEntry } from "./journal";
import { at, TEST_PROVENANCE, TEST_STABLE_ASSET, TEST_STABLE_SCALE } from "./test-support/journal-fixtures";

// The defect this file kills: an account whose holdings state is optional
// rather than paired to its family. A holdings account with no state keys as
// `holdings/-/asset`, which is a different `ledger_balances` row from
// `holdings/available/asset` — so one spendable balance splits in two, and
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
      provenance: TEST_PROVENANCE,
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

// The ledger's asset id IS `@vigil/contracts`' canonical identity — the
// schema below is contracts', imported rather than restated. These cases
// stay in this suite because the claim they protect is the ledger's: an
// account key built from a ticker would merge two chains' positions into
// one balance that reconciles against neither venue. Contracts owns the
// format; this owns what the ledger does with it.
describe("canonical asset identity", () => {
  const rejected: ReadonlyArray<{ name: string; assetId: string; catches: string }> = [
    { name: "a bare ticker", assetId: "BTC", catches: "symbol-as-identity, the defect this whole format exists to prevent" },
    { name: "a stablecoin ticker", assetId: "USDC", catches: "the same ticker issued on a dozen chains collapsing into one account" },
    {
      name: "the slice's own earlier fixture format",
      assetId: "test:stable-6",
      catches: "a pattern kept permissive enough to admit whatever the fixtures already used",
    },
    { name: "three components", assetId: "1|native|ETH", catches: "an id missing its withdrawal network, which two networks would then share" },
    { name: "an unknown kind", assetId: "1|ticker|BTC|mainnet", catches: "a fourth identity kind arriving without a decision about what it means" },
    { name: "an empty component", assetId: "1|native||mainnet", catches: "an id whose value component is missing entirely" },
    {
      name: "a component containing the instrument separator",
      assetId: "1|native|ETH/WBTC|mainnet",
      catches: "an asset id that would make a canonical instrument id ambiguous, and an account key unsplittable",
    },
  ];

  it.each(rejected)("refuses $name as an asset id — catches: $catches", ({ assetId }) => {
    expect(assetIdSchema.safeParse(assetId).success).toBe(false);
  });

  it("accepts each identity kind the contracts module defines — catches a pattern narrowed to whatever this package happens to use, which would refuse a mint- or contract-identified asset the moment one arrives", () => {
    for (const assetId of [
      "1|contract|0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48|ethereum",
      "solana:mainnet|mint|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v|solana",
      "cosmos:osmosis-1|native|uosmo|osmosis",
    ]) {
      expect([assetId, assetIdSchema.safeParse(assetId).success]).toEqual([assetId, true]);
    }
  });

  it("keys two same-ticker assets on different chains to different accounts — this is the whole point: one account per asset, never one account per symbol", () => {
    const ethereumUsdc = holdingsAccount(
      assetIdSchema.parse("1|contract|0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48|ethereum"),
      "available",
    );
    const polygonUsdc = holdingsAccount(
      assetIdSchema.parse("137|contract|0x3c499c542cef5e3811e1192ce70d8cc03d5c3359|polygon"),
      "available",
    );

    expect(accountKey(ethereumUsdc)).not.toBe(accountKey(polygonUsdc));
  });

  it("splits an account key back into family, state, and asset id at the first two separators — catches a key joined with a character the asset id also contains, where the parts could not be recovered and two accounts could collide", () => {
    const account = holdingsAccount(TEST_STABLE_ASSET, "reserved");
    const key = accountKey(account);
    const [family, state, ...rest] = key.split(ACCOUNT_KEY_SEPARATOR);

    expect(family).toBe("holdings");
    expect(state).toBe("reserved");
    expect(rest.join(ACCOUNT_KEY_SEPARATOR)).toBe(TEST_STABLE_ASSET);
  });
});
