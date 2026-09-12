# CI evidence and uncovered suites

Read this before claiming a test ran or a change is fully covered.

The repository and its CI exist: `.github/workflows/ci.yml` runs on
GitHub-hosted runners for every pull request and push against `main` and
`prod`. Evidence is the workflow run at the exact head SHA under review —
never a neighboring run, a stale head, or an inference from a green badge
elsewhere.

The fixed job names are `classify changes`, `lint`, `static checks`,
`unit tests`, `integration`, and the required aggregate `verify`. The
`classify changes` job selects which of the others run from the changed
paths; a draft PR runs nothing, a skipped job can be correct for that
revision, and a green `verify` therefore means the applicable jobs succeeded —
not that every suite in the repository ran.

- `unit tests` runs `pnpm test`: the root Vitest project's pure suites —
  every co-located `*.test.ts` in `apps/` and `packages/` — plus any
  `tests/replay/` or `tests/fault-injection/` scenario that does not need
  Postgres.
- `integration` runs `pnpm test:int`: every `*.int.test.ts` file, including a
  replay or fault-injection scenario that does need Postgres for a real
  reservation, reconciliation, or persistence path.
- `lint` and `static checks` run ESLint (type-aware), `lint:cycles` (madge),
  and `jscpd`; neither executes a test file.

For completion evidence:

1. Map each changed or added test file to the command that selects it
   (`pnpm test` or `pnpm test:int`).
2. Map that command to the CI job that actually ran at the tested commit:
   read that run's job list and logs at the head SHA under review rather
   than inferring a result from the job name alone.
3. Inspect job output when path filters or file arguments could exclude the
   file you care about.
4. Call any target suite outside the selected command **unverified**. Record
   the coverage gap in the current issue when issue editing is authorized, or
   report it to the owner for routing.

Do not use a local Vitest run to fill the gap — the root process rules forbid
every local application gate on this machine. Do not claim an unscheduled
suite ran because a neighboring CI job was green, and do not claim a suite
ran when its owning job did not appear in the run at the head SHA under
review.
