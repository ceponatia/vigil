# CI evidence and uncovered suites

Read this before claiming a test ran or a change is fully covered.

**No CI exists yet.** This repository is not a git repository and has no
GitHub remote; `.github/workflows/ci.yml` has never run. Everything below
describes the CI shape this repository is built toward, not evidence you can
currently cite. Until the GitHub repository exists and a workflow has actually
run at the head you are evaluating, every claim of "CI passed" is false — say
so plainly instead.

Once CI exists, the fixed job names are `classify changes`, `lint`,
`static checks`, `unit tests`, `integration`, and the required aggregate
`verify`. The `classify changes` job selects which of the others run from the
changed paths; a draft PR runs nothing, a skipped job can be correct for that
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
2. Map that command to the CI job that actually ran at the tested commit —
   impossible until the repository exists on GitHub; say so explicitly until
   then rather than inferring a result.
3. Once CI exists, inspect job output when path filters or file arguments
   could exclude the file you care about.
4. Call any target suite outside the selected command **unverified**. Record
   the coverage gap in the current issue when issue editing is authorized, or
   report it to the owner for routing.

Do not use a local Vitest run to fill the gap — the root process rules forbid
every local application gate on this machine. Do not claim an unscheduled
suite ran because a neighboring CI job was green, and do not claim CI ran at
all before the GitHub repository and its workflow exist.
