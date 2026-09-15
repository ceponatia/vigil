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
- `0007_decisions_and_ops_record_families` creates the `decisions` family
  (`candidates`, `candidate_tranches`, `candidate_evaluations`, and the
  `candidate_horizon` / `candidate_outcome` enums) and the `ops` family's
  `heartbeats`. Every table is new, so there is nothing to back-fill and no
  existing row to reinterpret.
- `0009_approved_intents_economics_attempts_and_outbox` creates the rest of
  the `intents` family — `approved_intents` with the executable-economics
  evidence that passed policy, `intent_cost_components`,
  `execution_attempts`, `intent_dispatch_outbox`, and the
  `net_edge_basis` / `cost_charge_basis` / `cost_component_kind` /
  `execution_attempt_state` / `dispatch_state` enums. Its constraints make a
  duplicated proposal, a duplicate attempt number, a second live attempt, a
  second economically consumed attempt, an intent that does not reach its
  own net-edge hurdle, and a cost total that no component supports all
  impossible. Every table is new, so there is nothing to back-fill and no
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
  an approved intent and its cost components; requires, at commit, that the
  components sum to the total incremental cost the net edge was derived
  from; holds an execution attempt to the lifecycle `docs/architecture.md`
  defines — opened in `SUBMITTING` with nothing spent, leaving `UNKNOWN`
  only on a reconciliation *named* in the same write and different from the
  one that settled it before, never lowering a confirmed amount, never
  written again once settled, and never opened at all on an intent an
  earlier attempt already consumed; and holds the outbox to being enqueued
  `pending` before any dispatch, with a payload digest that cannot be
  rewritten and a fencing token that cannot go backwards. Its refusals carry
  an explicit `CONSTRAINT` name so the store turns each rule into its own
  reason code rather than one opaque failure.

  The consumed-intent check takes a row lock on the intent's existing
  attempts before it looks, and that is not defensive habit: without it, a
  fill committed by another transaction after this trigger's snapshot was
  taken stayed invisible, the insert waited on the live-attempt index
  instead, and when the fill committed the insert went through — leaving a
  second dispatchable attempt on an intent whose capital had just been
  spent. The case is reproduced in
  `tests/fault-injection/concurrent-intent-consumption.int.test.ts`.
- `0011_intent_lifecycle_guard_gaps` replaces the two execution-attempt
  trigger functions in place and seals the cost evidence. It refuses an
  exchange attempt on an intent that routes over a chain, since the Exchange
  lifecycle cannot describe a broadcast; refuses an attempt threaded under a
  correlation id its intent is not threaded under; adds `attempt_id` to the
  immutable identity list, which previously compared every column around it
  and not itself; assigns the venue order identifier exactly once, so a later
  misassociated event cannot redirect reconciliation; refuses `FILLED` or
  `PARTIALLY_FILLED` with no confirmed amounts, which would otherwise settle
  an attempt out of the live index without entering the consumed one and
  leave the authorization open to a second attempt; and seals
  `intent_cost_components` against inserts from any transaction but the one
  that wrote the intent, using the `xmin` comparison
  `0005_journal_entry_sealed_guard` established.

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
