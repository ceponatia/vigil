# drizzle/

Generated SQL migrations only — the `drizzle-kit generate` output directory
configured in `drizzle.config.ts`. Never hand-edit a migration file after it
has merged; if a mistake needs fixing, generate a new migration on top of it.

`0000_ledger_baseline` creates the `journal` and `intents` record families
from `packages/db/src/schema/`. `0001_journal_append_only_guard` is a custom
(hand-authored) migration: it adds the trigger that rejects `UPDATE` and
`DELETE` against a posted journal entry or posting, which `drizzle-kit`
cannot generate from the schema. Its snapshot is identical to the previous
one by design — it makes no schema-model transition.

## Workflow

1. Change a schema module under `packages/db/src/schema/`.
2. Run `pnpm db:generate` to produce a new migration file here.
3. Review the generated SQL before committing it.
4. Run `pnpm db:migrate` to apply it.

Never run `drizzle-kit push` in this workspace — migrations are the only
path from schema to database, so the history here stays the reproducible
source of truth for every environment.

## Applying

`pnpm db:migrate` applies every migration here in journal order, from an
empty database to the current schema. The `integration` CI job does exactly
that against a fresh Postgres before running the Postgres-backed suites.
