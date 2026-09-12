# Data migrations and database operations

## Choose the durable mechanism

Use a checked-in, guarded SQL migration when database-backed rows must
converge in every environment as part of release history. Match exact known
prior values when replacing catalog data so an administrator's independent
edits are not silently overwritten. Make inserts conflict-aware and updates or
deletes narrow enough to explain every affected row.

Use an operational script or bounded query only for a target-specific repair,
investigation, or backfill that does not belong in every environment. Treat
any write as a mutation even if it is described as cleanup or repair. Prefer a
dry-run or read-only preflight, stable batches, resumable progress, explicit
transactions where appropriate, and a postcondition that distinguishes zero
matching rows from success.

Source-backed registries — reason codes, operating modes, venue capability
flags — are ordinary code/data edits unless their persisted representation
changes. Do not introduce SQL merely because the word "registry" appears in
the task.

## Target and authorization

Before an operational action, establish and report without secrets:

- environment: local Docker Compose Postgres, or a named hosted target;
- for local compose, the `docker-compose.yml` service you inspected and its
  Postgres 18 version;
- for a hosted target, an identifier sufficient to disambiguate it (project or
  instance name, database name) and never a connection string — the hosted
  target itself is an open owner decision, so do not assume any particular
  provider's tooling or naming;
- the schema version or pending migration set;
- whether the action is read-only, migration application, backfill, or repair;
- the existing session instruction that authorizes the mutation.

If the target cannot be distinguished or the requested mutation exceeds the
existing authorization, stop before the write. Do not print a connection URL,
password, token, complete environment dump, or user content as evidence. Never
let personal holdings, wallet addresses, or credentials from the private
project handoff appear in a query, log, or report — see the repository root
rules.

## Applying and verifying

`pnpm db:migrate` (`drizzle-kit migrate`) applies repository migrations from
`drizzle/` to whatever target its connection configuration currently points
at. Apply it only to the known, authorized target, and never as a side effect
of another task. There is no fixed seed script yet; if one is added later,
treat it exactly like migration — never inferred permission, never automatic,
never run against a hosted target without explicit authorization.

After an authorized write, verify the effect at the same target:

1. Confirm the expected migration history through a schema-aware query (for
   example, Drizzle's own migrations tracking table) rather than guessing a
   metadata relation name.
2. Check the changed columns, constraints, indexes, or guarded row predicate
   directly, using counts or redacted identifiers rather than sensitive row
   contents.
3. Detect partial work, skipped guarded rows, and unexpected matches
   explicitly.
4. Report which checks were not run. A successful command exit alone does not
   prove the intended data changed. No deployed environment or release
   process exists yet, so there is no deployed-behavior check to run.

Avoid automatic retries for non-idempotent writes. If the result is uncertain,
inspect target state before deciding whether another attempt is safe.
