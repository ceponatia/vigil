# drizzle/

Generated SQL migrations only — the `drizzle-kit generate` output directory
configured in `drizzle.config.ts`. Never hand-edit a migration file after it
has merged; if a mistake needs fixing, generate a new migration on top of it.

Generated from `packages/db/src/schema/`:

- `0000_ledger_baseline` creates the `journal` and `intents` record families.
- `0002_reservation_one_live_hold_per_intent` adds the partial unique index
  that allows one active hold per intent.
- `0004_asset_scale_registry_and_provenance` adds `asset_scales`, the
  composite `(asset_id, asset_scale)` foreign keys into it, and the
  provenance columns on journal entries and reservations. Its two
  `NOT NULL` columns are added without a default, which requires the tables
  to be empty — they are in every environment, since nothing is deployed and
  CI migrates from zero.
- `0009_approved_intents_attempts_and_outbox` creates the rest of the
  `intents` family — `approved_intents`, `execution_attempts`,
  `intent_dispatch_outbox`, and the `execution_attempt_state` /
  `dispatch_state` enums — with the unique keys that make a duplicated
  proposal, a duplicate attempt number, a second live attempt, and a second
  economically consumed attempt impossible. Every table is new, so there is
  nothing to back-fill and no existing row to reinterpret.
- `0007_decisions_and_ops_record_families` creates the `decisions` family
  (`candidates`, `candidate_tranches`, `candidate_evaluations`, and the
  `candidate_horizon` / `candidate_outcome` enums) and the `ops` family's
  `heartbeats`. Every table is new, so there is nothing to back-fill and no
  existing row to reinterpret.

Hand-authored (`drizzle-kit generate --custom`), because `drizzle-kit`
cannot derive a trigger from the schema:

- `0001_journal_append_only_guard` rejects `UPDATE` and `DELETE` against a
  posted journal entry or posting.
- `0003_journal_entry_balanced_guard` rejects, at commit, an entry whose
  debits and credits do not match.
- `0005_journal_entry_sealed_guard` rejects postings added to an entry that
  an earlier transaction posted.
- `0006_journal_balance_by_asset_scale` regroups the balance guard by
  `(asset_id, asset_scale)`, so two amounts at different scales can never
  cancel.
- `0008_candidate_append_only_guard` rejects `UPDATE` and `DELETE` against a
  stored candidate and its tranches. `candidate_evaluations` is deliberately
  left unguarded: evaluations accumulate and readers take the newest, so
  appending is already the correction path there.
- `0010_intent_lifecycle_guards` rejects every `UPDATE` and `DELETE` against
  an approved intent, holds an execution attempt to the lifecycle
  `docs/architecture.md` defines — opened in `SUBMITTING` with nothing spent,
  leaving `UNKNOWN` only with a reconciliation recorded in the same write,
  never lowering a confirmed amount, never written again once settled, and
  never opened at all on an intent an earlier attempt already consumed — and
  holds the outbox to being enqueued `pending` before any dispatch, with a
  payload digest that cannot be rewritten and a fencing token that cannot go
  backwards. Its refusals carry an explicit `CONSTRAINT` name so the store
  turns each rule into its own reason code rather than one opaque failure.

The `0009` and `0010` pair is the family's ordering rule in miniature: the
composite foreign key from the outbox to `(intent_id, attempt)` makes the
attempt's uniqueness a table **constraint** rather than a bare unique index,
because `drizzle-kit` emits foreign keys before it creates indexes and a
reference needs something to match at the moment it is added.

Each custom migration carries a snapshot identical to the previous one by
design: a migration that adds only DDL makes no schema-model transition, so
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
