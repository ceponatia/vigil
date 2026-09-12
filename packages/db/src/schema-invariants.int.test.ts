import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { schema } from "./client";
import { journalEntries, journalLines, ledgerBalances } from "./schema/journal";
import { postJournalEntry } from "./store/journal-store";
import { postgresErrorCode, PG_CHECK_VIOLATION, PG_RAISE_EXCEPTION } from "./store/pg-errors";
import { fundingEntry, openLedgerTestDb } from "./test-support/journal-fixtures";

// Lives beside src/, NOT under src/schema/: drizzle.config.ts globs
// `packages/db/src/schema/*.ts`, so a test file in that directory would be
// loaded as if it were a schema module.
//
// The defects this file kills:
//   * a money column that is a float, where a rounding error becomes a
//     balance nobody can reconcile;
//   * an idempotency key with an index instead of a unique constraint, which
//     stops nothing;
//   * a posted journal entry that can be edited or deleted in place;
//   * a holdings balance that can be driven negative by a direct write;
//   * a constraint that exists in packages/db/src/schema/ but never reached
//     drizzle/, so the migration CI applies does not carry it.
//
// Almost every claim is asserted against the migrated database — the schema
// CI actually builds from `drizzle/`, reached through `information_schema`,
// `pg_indexes`, and `pg_constraint`. Where an expectation is derived from
// the TypeScript schema it is only the left-hand side of that comparison:
// the schema says what must exist, and the migrated database is asked
// whether it does. The one claim made against the schema alone is the
// financial-tables rule from AGENTS.md, whose literal key list is the
// contract itself — deriving that one from the schema would assert the
// schema against itself and prove nothing.

const { db, close, reset } = openLedgerTestDb("vigil-schema-test");

afterAll(close);
beforeEach(reset);

// Every table the Drizzle schema declares, discovered rather than listed:
// a table added to packages/db/src/schema/ without a migration shows up
// below as a missing constraint, not as a case nobody remembered to add.
// `schema` also holds the enums and the precision constants, so the tables
// are picked out by identity rather than by name.
function asPgTable(value: unknown): PgTable | null {
  return is(value, PgTable) ? value : null;
}

const schemaTables: readonly PgTable[] = Object.values(schema)
  .map((value) => asPgTable(value))
  .filter((table): table is PgTable => table !== null);

function declaredUniqueIndexNames(): readonly string[] {
  const fromIndexes = schemaTables
    .flatMap((table) => getTableConfig(table).indexes)
    .filter((declared) => declared.config.unique)
    .map((declared) => declared.config.name);
  const fromConstraints = schemaTables
    .flatMap((table) => getTableConfig(table).uniqueConstraints)
    .map((declared) => declared.name);

  return [...fromIndexes, ...fromConstraints].filter((name): name is string => name !== undefined).sort();
}

function declaredCheckNames(): readonly string[] {
  return schemaTables
    .flatMap((table) => getTableConfig(table).checks)
    .map((declared) => declared.name)
    .sort();
}

async function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

async function publicColumns(): Promise<readonly ColumnRow[]> {
  const result = await db.execute<ColumnRow>(sql`
    select table_name, column_name, data_type, numeric_precision, numeric_scale
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `);
  return result.rows;
}

describe("money and quantity columns", () => {
  it("has migrated tables to inspect — an empty information_schema result would make every claim below pass vacuously", async () => {
    const columns = await publicColumns();
    const tables = new Set(columns.map((column) => column.table_name));

    expect([...tables].sort()).toEqual(
      expect.arrayContaining(["journal_entries", "journal_lines", "ledger_balances", "reservations"]),
    );
  });

  it("has no real or double precision column anywhere in the schema — catches the first slice that reaches for a float price or quantity column", async () => {
    const floats = (await publicColumns()).filter((column) =>
      ["real", "double precision", "float", "float4", "float8"].includes(column.data_type),
    );

    expect(floats).toEqual([]);
  });

  it("stores every base-unit column as numeric with scale 0 and room for a 256-bit integer — catches a bigint column, which overflows at roughly 9.2 units of an 18-decimal asset", async () => {
    const baseUnitColumns = (await publicColumns()).filter((column) => column.column_name.endsWith("_base"));

    expect(baseUnitColumns.length).toBeGreaterThan(0);
    for (const column of baseUnitColumns) {
      expect(`${column.table_name}.${column.column_name}: ${column.data_type}`).toBe(
        `${column.table_name}.${column.column_name}: numeric`,
      );
      expect(column.numeric_scale).toBe(0);
      expect(column.numeric_precision).toBe(78);
    }
  });

  it("pairs every base-unit column's table with an explicit asset scale column — base units without a scale are an uninterpretable integer", async () => {
    const columns = await publicColumns();
    const tablesWithBaseUnits = new Set(
      columns.filter((column) => column.column_name.endsWith("_base")).map((column) => column.table_name),
    );
    const tablesWithScale = new Set(
      columns.filter((column) => column.column_name === "asset_scale").map((column) => column.table_name),
    );

    for (const table of tablesWithBaseUnits) {
      expect([table, tablesWithScale.has(table)]).toEqual([table, true]);
    }
  });
});

describe("idempotency and correlation keys", () => {
  // The literal list is the contract, not a restatement of the schema:
  // AGENTS.md "Database changes" requires a unique constraint — never a
  // bare index — on every idempotency and correlation key, and a schema
  // that quietly demoted one would satisfy a purely derived check.
  it("declares a unique index on each key the financial-tables rule names — catches an idempotency key indexed for speed and unenforced for correctness, which stops nothing", () => {
    expect(declaredUniqueIndexNames()).toEqual(
      expect.arrayContaining([
        "journal_entries_idempotency_key_key",
        "journal_entries_reverses_entry_id_key",
        "reservations_idempotency_key_key",
        "reservations_intent_id_active_key",
        "reservations_intent_id_attempt_key",
        "reservations_journal_entry_id_key",
      ]),
    );
  });

  it("has every unique index the schema declares, still unique, in the migrated database — catches a constraint that lives in packages/db/src/schema/ and never reached drizzle/, where uniqueness would be enforced in code review and nowhere the application actually writes", async () => {
    const declared = declaredUniqueIndexNames();
    expect(declared.length).toBeGreaterThan(0);

    const result = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
    `);
    const uniqueInDatabase = new Set(
      result.rows.filter((row) => row.indexdef.includes("CREATE UNIQUE INDEX")).map((row) => row.indexname),
    );

    expect(declared.filter((name) => !uniqueInDatabase.has(name))).toEqual([]);
  });

  it("has every check constraint the schema declares in the migrated database — catches ledger_balances_holdings_never_negative existing only in TypeScript, which would leave the no-overspend guarantee an application convention again", async () => {
    const declared = declaredCheckNames();
    expect(declared).toContain("ledger_balances_holdings_never_negative");

    const result = await db.execute<{ conname: string }>(sql`
      select c.conname
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.contype = 'c'
    `);
    const inDatabase = new Set(result.rows.map((row) => row.conname));

    expect(declared.filter((name) => !inDatabase.has(name))).toEqual([]);
  });
});

describe("append-only journal", () => {
  it("rejects an UPDATE against a posted entry and leaves it unchanged — catches a correction applied by editing the original, which erases what the application believed at the time", async () => {
    const posted = await postJournalEntry(db, fundingEntry("entry-append-only", 1_000_000n));
    expect(posted.outcome).toBe("posted");

    const failure = await errorFrom(() =>
      db.execute(sql`update ${journalEntries} set kind = 'fee' where entry_id = 'entry-append-only'`),
    );

    expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);

    const after = await db.execute<{ kind: string }>(
      sql`select kind from ${journalEntries} where entry_id = 'entry-append-only'`,
    );
    expect(after.rows[0]?.kind).toBe("contribution");
  });

  it("rejects a DELETE against a posted entry and its lines — catches a cleanup path that removes an entry instead of reversing it", async () => {
    const posted = await postJournalEntry(db, fundingEntry("entry-undeletable", 1_000_000n));
    expect(posted.outcome).toBe("posted");

    const entryFailure = await errorFrom(() =>
      db.execute(sql`delete from ${journalEntries} where entry_id = 'entry-undeletable'`),
    );
    const lineFailure = await errorFrom(() =>
      db.execute(sql`delete from ${journalLines} where entry_id = 'entry-undeletable'`),
    );

    expect(postgresErrorCode(entryFailure)).toBe(PG_RAISE_EXCEPTION);
    expect(postgresErrorCode(lineFailure)).toBe(PG_RAISE_EXCEPTION);

    const remaining = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${journalLines} where entry_id = 'entry-undeletable'`,
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });
});

describe("holdings balances", () => {
  it("refuses a direct write that would drive a holdings account negative — this constraint, not application ordering, is what stops two concurrent reservations from both committing", async () => {
    const posted = await postJournalEntry(db, fundingEntry("entry-guarded", 1_000_000n));
    expect(posted.outcome).toBe("posted");

    const failure = await errorFrom(() =>
      db.execute(
        sql`update ${ledgerBalances} set credit_base = credit_base + 2000000 where account_key = 'holdings|available|test:stable-6'`,
      ),
    );

    expect(postgresErrorCode(failure)).toBe(PG_CHECK_VIOLATION);
  });

  it("permits a non-holdings account to hold a credit balance — catches a blanket non-negative constraint that would make contributed capital or a realized loss unpostable", async () => {
    const posted = await postJournalEntry(db, fundingEntry("entry-capital", 1_000_000n));

    expect(posted.outcome).toBe("posted");
    const capital = await db.execute<{ credit_base: string }>(
      sql`select credit_base::text as credit_base from ${ledgerBalances} where account_key = 'contributed-capital|-|test:stable-6'`,
    );
    expect(capital.rows[0]?.credit_base).toBe("1000000");
  });
});
