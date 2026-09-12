# Database change review

## Identity and classification

- Change: `[issue or concise purpose]`
- Class: `[source registry | schema | durable data migration | operational action]`
- Schema/data owner: `[file under packages/db/src/schema/, table, or registry]`
- Intended target: `[none during authoring | local compose | named hosted target]`
- Mutation authorization: `[not needed | existing session instruction]`

## Artifacts

- [ ] The `packages/db/src/schema/*.ts` change is necessary and matches the intended contract.
- [ ] Migration SQL was reviewed statement by statement.
- [ ] `drizzle/meta/_journal.json` has the expected new entry.
- [ ] The generated schema snapshot matches the SQL, or this is explicitly a data-only migration with no schema snapshot.
- [ ] Existing migration history was not rewritten or renumbered.
- [ ] No `drizzle-kit push` was used, and Drizzle's create-versus-rename prompt, if it appeared, was resolved by the owner interactively, not automated.

Artifacts reviewed: `[paths and migration tag]`

## Financial tables

- [ ] Money and quantity columns are `numeric`, a text decimal string, or a `bigint` base-unit column with an explicit scale — never `real`/`double precision`.
- [ ] Idempotency and correlation keys carry unique constraints.
- [ ] Journal-entry tables are append-only; no `UPDATE`/`DELETE` path exists; corrections are reversing entries.
- [ ] An approved intent is immutable after approval; retries/refreshes are new versioned attempt rows referencing it.
- [ ] Every economic record carries the timestamp family from `packages/contracts` appropriate to its stage.
- [ ] No column stores a plaintext secret or signing material.

## Existing data and compatibility

- Existing-row behavior: `[default, null state, and backfill separately]`
- Backfill guard and unmatched-row behavior: `[predicate and expected counts]`
- Data-loss analysis: `[drops, deletes, casts, truncation, cascades, uniqueness]`
- Lock and runtime analysis: `[large updates, indexes, constraints]`
- Old application with migrated schema: `[compatible or staged requirement]`
- New application with migrated schema: `[expected contract]`
- Forward recovery: `[safe action if app release fails after migration]`

## Execution order

1. `[preflight or expansion]`
2. `[checked-in migration / bounded operation]`
3. `[application release or backfill]`
4. `[validation and later contract step, if any]`

- [ ] No `drizzle-kit push` is used.
- [ ] No hosted-target migration, backfill, or repair is implied by authoring approval.
- [ ] Secrets, credentials, and personal holdings are absent from logs and evidence.
- [ ] The financial-tables checklist above is satisfied for every affected table.

## Evidence

- CI job and exact selected suite: `[job / command / paths, or "no CI exists yet"]`
- Fresh-database migration result: `[evidence or unverified]`
- Representative populated upgrade/backfill result: `[evidence or unverified]`
- Target postconditions: `[redacted query/tool result or unverified]`
- Remaining risk: `[specific limitation]`
