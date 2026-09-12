# tests/

Cross-package suites and synthetic fixtures that don't belong to any single
`apps/*` or `packages/*` project.

## Layout

- **`fixtures/`** — synthetic data only: deterministic, reproducible, and
  never containing personal holdings, real wallet/exchange addresses, or
  keys of any kind.
- **`replay/`** — deterministic, full-lifecycle replays that drive a
  scenario end to end through the paper adapter (research/candidate through
  journal entry), asserting on the final state rather than on each step.
- **`fault-injection/`** — the fault scenario matrix described in
  `docs/testing.md` (crash mid-write, duplicate delivery, stale data,
  partial fill, and similar cases the system must fail closed on).

## Naming and selection

A file named `*.test.ts` is a unit test: no external services, safe to run
anywhere. A file named `*.int.test.ts` is an integration test: it needs the
Postgres container from `docker-compose.yml` (`pnpm db:up` first).

The root `vitest.config.ts` is the only Vitest config in the workspace. Its
`unit` project includes `tests/**/*.test.ts` (among other globs) and
excludes every `*.int.test.ts`; its `integration` project includes every
`*.int.test.ts` in the repository. Nothing under `tests/` needs its own
Vitest config or `package.json` — the root config already reaches it by glob.

## Status

Empty. No fixtures, replays, or fault-injection scenarios exist yet.
