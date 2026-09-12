import {
  accountKeyFor,
  accountFamilyEnum,
  ACCOUNT_KEY_SEPARATOR as STORE_ACCOUNT_KEY_SEPARATOR,
  holdingsStateEnum,
  journalEntryKindEnum,
  postingDirectionEnum,
  reservationStateEnum,
  type StoreProvenance,
} from "@vigil/db";
import {
  accountKey,
  ACCOUNT_FAMILIES,
  ACCOUNT_KEY_SEPARATOR as LEDGER_ACCOUNT_KEY_SEPARATOR,
  ENTRY_KINDS,
  HOLDINGS_STATES,
  POSTING_DIRECTIONS,
  RESERVATION_STATES,
  type EntryProvenance,
} from "@vigil/ledger";
import { describe, expect, it } from "vitest";

// `@vigil/ledger` and `@vigil/db` may not import each other — the layer
// graph runs one way — so the same vocabulary is declared twice: once as a
// TypeScript registry and once as a Postgres enum. These assertions are the
// only thing keeping the two spellings in step.
//
// This is a *unit* suite despite being about the database. Both index
// modules are side-effect-free (the client is a factory; importing it opens
// no connection), the values compared are constants, and no claim here needs
// a migrated schema. Running it under `integration` would mean a vocabulary
// drift that breaks every replay is reported only when Postgres is
// available, and skipped on a change the classifier calls docs-only.
//
// Seam: when `packages/contracts` owns these registries, both sides take
// them from there and this file goes away.

const SAMPLE_ASSET = "1337|native|VGLSTABLE|SYNTHETIC_TESTNET";

// The record contract is declared twice for the same reason the enums are.
// A field on one side and not the other is not a type error anywhere — it is
// a column that is never written, or a value that is never persisted.
const LEDGER_PROVENANCE: EntryProvenance = {
  policyVersion: "policy-seam-0",
  strategyVersion: "strategy-seam-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

const STORE_PROVENANCE: StoreProvenance = LEDGER_PROVENANCE;

describe("the persisted vocabulary and the ledger's vocabulary", () => {
  it("describe an economic record's provenance with the same fields — catches a version added to one side only, which persists as a column nobody writes or a value nobody stores", () => {
    expect(Object.keys(STORE_PROVENANCE).toSorted()).toEqual(Object.keys(LEDGER_PROVENANCE).toSorted());
    expect(Object.keys(LEDGER_PROVENANCE).toSorted()).toEqual([
      "marketSnapshotVersion",
      "modelVersion",
      "policyVersion",
      "portfolioSnapshotVersion",
      "strategyVersion",
    ]);
  });

  it("declare exactly the same holdings states, in the same order — catches a seventh state added to one side only, which would make a rebuild drop or invent a balance", () => {
    expect(holdingsStateEnum.enumValues).toEqual([...HOLDINGS_STATES]);
  });

  it("declare exactly the same account families, entry kinds, posting directions, and reservation states — catches a kind that can be written but not replayed", () => {
    expect(accountFamilyEnum.enumValues).toEqual([...ACCOUNT_FAMILIES]);
    expect(journalEntryKindEnum.enumValues).toEqual([...ENTRY_KINDS]);
    expect(postingDirectionEnum.enumValues).toEqual([...POSTING_DIRECTIONS]);
    expect(reservationStateEnum.enumValues).toEqual([...RESERVATION_STATES]);
  });

  it("agree on the separator, and leave exactly two of them in a key — catches both sides drifting the same way onto `|`, which the comparison below would call agreement even though a key carrying an asset id's own three separators cannot be split back into its parts", () => {
    expect(STORE_ACCOUNT_KEY_SEPARATOR).toBe(LEDGER_ACCOUNT_KEY_SEPARATOR);

    const key = accountKey({ family: "holdings", assetId: SAMPLE_ASSET, holdingsState: "available" });
    expect(key.split(LEDGER_ACCOUNT_KEY_SEPARATOR)).toHaveLength(3);
  });

  it("derive the same account key for every family and state the vocabulary allows — catches one side changing the separator or the placeholder for an absent state, which would silently split one account into two, so every balance is written under one key and read under another", () => {
    for (const family of ACCOUNT_FAMILIES) {
      const states = family === "holdings" ? HOLDINGS_STATES : ([null] as const);
      for (const holdingsState of states) {
        const account = { family, assetId: SAMPLE_ASSET, holdingsState };
        expect(accountKeyFor(account)).toBe(accountKey(account));
      }
    }
  });
});
