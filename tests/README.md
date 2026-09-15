# tests/

Cross-package suites and synthetic fixtures that don't belong to any single
`apps/*` or `packages/*` project.

## Layout

- **`fixtures/`** — synthetic data only: deterministic, reproducible, and
  never containing personal holdings, real wallet/exchange addresses, or
  keys of any kind.
- **`replay/`** — deterministic, full-lifecycle replays that drive a
  scenario end to end through real repository seams (research/candidate
  through journal entry), asserting on the final state rather than on each
  step. Suites here may not import an `adapter-*` package — only
  `apps/trading` may — so a replay that must drive the paper adapter lives
  beside the owning `apps/*` code instead, as an `*.int.test.ts`; see
  `tests/replay/README.md`.
- **`fault-injection/`** — the fault scenario matrix described in
  `docs/testing.md` (crash mid-write, duplicate delivery, stale data,
  partial fill, and similar cases the system must fail closed on), for
  scenarios drivable against `@vigil/contracts`, `@vigil/db`,
  `@vigil/ledger`, and `@vigil/market` alone. A scenario that needs a real
  adapter lives beside its owning `apps/*` code instead, as an
  `*.int.test.ts`; see `tests/fault-injection/README.md`.
- **`seams/`** — claims about two packages agreeing, where neither package
  can import the other to make the agreement a type. Pure suites: a seam
  test that needed a running service would belong to the layer that owns the
  service.

## Naming and selection

A file named `*.test.ts` is a unit test: no external services, safe to run
anywhere. A file named `*.int.test.ts` is an integration test: it needs the
Postgres container from `docker-compose.yml` (`pnpm db:up` first).

The root `vitest.config.ts` is the only Vitest config in the workspace. Its
`unit` project includes `tests/**/*.test.ts` (among other globs) and
excludes every `*.int.test.ts`; its `integration` project includes every
`*.int.test.ts` in the repository. Nothing under `tests/` needs its own
Vitest config or `package.json` — the root config already reaches it by glob.

## What lives here

`replay/` holds two suites: `synthetic-market.test.ts`, a plain unit suite
proving the BOOT-03 market fixture is deterministic, and
`journal-rebuild.int.test.ts`, which drives a multi-asset history through
`@vigil/db` and rebuilds it with `@vigil/ledger` from an empty runtime
state. `fault-injection/` holds three `*.int.test.ts` suites — one on
concurrent reservations, one on concurrent intent consumption, and one on a
concurrent expiry sweep — each driving two independent Postgres connections
at one shared piece of state. `seams/` holds the ledger-and-database
vocabulary check, a plain unit suite. `fixtures/` holds `synthetic-market.ts`,
the BOOT-03 synthetic market generator the suites above and BOOT-08's
vertical replay consume.
