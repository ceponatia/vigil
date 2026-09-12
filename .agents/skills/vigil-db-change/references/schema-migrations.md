# Schema migrations

## Authoring sequence

1. Edit the owning module under `packages/db/src/schema/` as the schema source
   of truth — one file per record family: `assets.ts`, `venues.ts`,
   `evidence.ts`, `decisions.ts`, `policies.ts`, `intents.ts`, `orders.ts`,
   `transactions.ts`, `journal.ts`, `yield.ts`, `treasury.ts`, `outcomes.ts`,
   `ops.ts`.
2. From the repository root, run `pnpm db:generate` (`drizzle-kit generate`)
   only when generation is in scope. `drizzle.config.ts` at the repository
   root globs `packages/db/src/schema/*.ts` and writes to `drizzle/`.
3. If Drizzle asks whether an object was created or renamed, stop. The diff is
   ambiguous; the owner must run generation interactively. Never script an
   answer, allocate a fake TTY, pipe `yes`, or leave stdin unbounded.
4. Review the new SQL and `drizzle/meta/_journal.json`. For a generated schema
   migration, also review the new snapshot as part of the same change. Confirm
   the journal index/tag, SQL, and snapshot describe one coherent transition
   and do not overwrite concurrent migration history.
5. Inspect SQL before any application. Do not substitute `drizzle-kit push`
   for checked-in migrations. `pnpm db:migrate` (`drizzle-kit migrate`) is the
   only sanctioned apply path, and this skill never runs it automatically.

Do not rewrite or renumber existing history to make a new migration fit.

A guarded, data-only migration can be journaled without a new schema snapshot.
Classify it explicitly and confirm that it makes no schema transition rather
than fabricating snapshot churn.

## Financial tables

Every migration touching a table in the financial record families (assets,
venues, intents, orders, transactions, journal, yield, treasury, outcomes)
gets the checklist in [SKILL.md](../SKILL.md)'s Financial tables section
applied before the migration is reviewed as complete. In particular: confirm a
new or changed money/quantity column is `numeric`, a decimal string, or a
scaled `bigint`, never `real`/`double precision`; confirm a new idempotency or
correlation column carries a unique constraint; and confirm no migration adds
an `UPDATE`/`DELETE` path to a journal-entry table.

## Semantic review

For every affected table, answer these questions from current data and both
application versions:

- What happens to existing rows? Separate a database default for future
  inserts, a migration-time backfill, and an application fallback.
- Can the column be null during rollout? For a populated table, prefer an
  expand/backfill/validate/contract sequence when adding `NOT NULL`,
  uniqueness, or a restrictive foreign key cannot be proven safe in one
  bounded migration.
- Is the backfill guarded, deterministic, idempotent, and narrow enough to
  preserve operator-edited rows? State how unmatched and malformed rows
  behave.
- Can a cast truncate, reinterpret, or reject stored values? Can a drop,
  delete, cascade, uniqueness constraint, or replacement table lose data?
- Do index or constraint creation and large updates hold locks long enough to
  affect the serving application?
- Do `onDelete`, defaults, check constraints, and indexes match the
  application contract rather than merely allowing generation to pass?
- Is forward recovery clear if the release command succeeds but the new
  application fails? Do not rely on a destructive down migration as the
  recovery plan.

## Deployment and evidence

No deployment target or hosted release process is chosen yet — there is no
hosting configuration file for `apps/trading` or `apps/control`; do not assume
one. Until a target is chosen, evidence is limited to a fresh local
Postgres migration and CI once it exists: the `integration` job runs
`pnpm test:int` against a fresh Postgres 18 instance the workflow provisions.
That proves only that checked-in migration history builds that fresh schema
and that `pnpm test:int`'s current selection passed — it does not prove an
upgrade of representative populated data, production lock behavior, a
backfill's preservation rules, or any suite the script does not select. State
plainly that no CI exists until the GitHub repository is created and a
workflow has actually run there.

Before delivery, record:

- the schema and migration files reviewed;
- the financial-tables checklist result for every affected table;
- expected row transformations and any preflight evidence;
- the old-app/new-schema and new-app/new-schema compatibility result;
- the exact CI job and selected coverage, if run, or that no CI exists yet;
- the intended release order and forward-recovery action;
- deployed migration and application checks only when they actually ran
  against the identified target.
