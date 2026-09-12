# drizzle/

Generated SQL migrations only — the `drizzle-kit generate` output directory
configured in `drizzle.config.ts`. Never hand-edit a migration file after it
has merged; if a mistake needs fixing, generate a new migration on top of it.

`0000_ledger_baseline` creates the `journal` and `intents` record families
from `packages/db/src/schema/`. `0002_reservation_one_live_hold_per_intent`
adds the partial unique index that allows one active hold per intent.

Two migrations here are custom (hand-authored) rather than generated,
because `drizzle-kit` cannot derive a trigger from the schema:

- `0001_journal_append_only_guard` rejects `UPDATE` and `DELETE` against a
  posted journal entry or posting.
- `0003_journal_entry_balanced_guard` rejects, at commit, an entry whose
  debits and credits do not match for every asset it touches.

Each of the two carries a snapshot identical to the previous one by design:
a custom migration that adds only DDL makes no schema-model transition, so
there is nothing for the snapshot to record.

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
