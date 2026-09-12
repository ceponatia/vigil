---
name: vigil-db-change
description: Plan, implement, review, and verify vigil database schema migrations, durable data changes, and authorized database operations. Use when changing the Drizzle schema or migration history, backfilling stored data, changing database-backed catalog rows, or acting on a known database target.
---

# vigil database changes

Classify the change before editing or acting:

| Change | Owner and path |
| --- | --- |
| Registry vocabulary stored in source, such as reason codes, operating modes, or venue capability flags | Edit the owning package's registry data (typically `packages/contracts`). Do not create a database migration unless the persisted shape changes. |
| Tables, columns, indexes, constraints, foreign keys, or stored types | Edit the owning module under `packages/db/src/schema/`, then follow the schema-migration workflow. |
| Durable database-backed defaults, catalog rows, or backfills | Use guarded migration SQL when every environment must converge. A schema edit may be unnecessary. |
| Inspecting or mutating a database target, applying migrations, or a one-off repair | Treat this as an operational database action against an explicitly identified target. |

Read [schema-migrations.md](references/schema-migrations.md) for schema,
generated migration, compatibility, or deploy-order work. Read
[data-operations.md](references/data-operations.md) for data migrations,
backfills, or actions against a real database target. Use
[database-change-review.md](templates/database-change-review.md) to make a
change reviewable — it includes the financial-tables checklist below.

## Guardrails

- Work from the repository root. Read `docs/README.md`, `docs/architecture.md`,
  and `docs/getting-started.md`, plus the documentation for the affected
  database-backed system.
- Identify the exact database target before any action against it. Local
  development uses Postgres 18 via `docker-compose.yml` (`pnpm db:up` /
  `pnpm db:down`). The hosted database target is an open owner decision — do
  not assume a specific provider's branch model, CLI, project/instance shape,
  or pooling behavior; name it generically ("the hosted target") and leave a
  `TODO(bootstrap): …` where a real identifier is needed. Preserve the
  repository's Drizzle and `pg` stack.
- Never use `drizzle-kit push`. Never automate Drizzle's create-versus-rename
  prompt with a fake TTY, `yes`, or unbounded input. If that prompt appears,
  stop generation and have the owner run `pnpm db:generate` interactively.
- Do not automatically run `pnpm db:migrate`, or any seed or backfill script,
  against any target — local or hosted. Bringing up local compose
  (`pnpm db:up`) is fine only when the current task authorizes it.
- Do not run local application tests, lint, typecheck, builds, or Vitest. Use
  `vigil-testing` to identify the owning coverage and the exact CI job that
  selects it (`unit tests` runs `pnpm test`; `integration` runs
  `pnpm test:int`). A green aggregate `verify` does not prove an unselected
  suite ran.
- No deployed or hosted environment exists yet, and no CI exists until the
  GitHub repository is created. Report only what actually ran against the
  target you actually reached — local compose, or the hosted target once one
  exists and is authorized.

## Financial tables

Apply this review to every table that stores money, quantities, or economic
identity, in addition to the ordinary schema review:

- Money and quantity columns are `numeric`, a text decimal string, or a
  `bigint` base-unit column with an explicit, documented scale — never `real`
  or `double precision`.
- Idempotency and correlation keys (economic action ID, intent ID,
  client-order ID, transaction/attempt ID) carry a unique constraint, not just
  an index.
- Journal-entry tables are append-only: no application path issues `UPDATE` or
  `DELETE` against a posted entry; a correction is a new reversing entry.
- An approved intent is immutable after approval; a retry or refreshed
  execution is a new versioned attempt row that references the original
  intent, never a rewrite of it.
- Every economic record carries the timestamp family from `packages/contracts`
  appropriate to its stage, not a single generic `createdAt`.
- No column ever stores a plaintext secret, private key, signing material, or
  credential; a credential is a reference to an external secret store.

## Completion record

State the classification, affected schema/data contract, generated or
hand-authored artifacts, the financial-tables review result for every affected
table, compatibility and data-loss analysis, deployment order, exact target
evidence, and what remains unverified. Do not claim migration, seed, or
deployed application unless it actually ran against the named target.
