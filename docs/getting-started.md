# Getting started

## Prerequisites

- Node 24, matching `.node-version` (`24.14.0`) — install with fnm, nvm, or volta rather than a system package
- pnpm `11.26.0` via corepack:

  ```bash
  corepack enable && corepack prepare pnpm@11.26.0 --activate
  ```

- Docker, with Compose, for local Postgres
- Python 3.12+, for the repository's hooks

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
```

`pnpm db:migrate` applies the checked-in migrations under `drizzle/` in order, from an empty database to the current schema. It is the only sanctioned path from schema to database; `drizzle-kit push` is never used.

## Running

```bash
pnpm dev:trading
pnpm dev:control
```

Both start nothing yet: `apps/trading` and `apps/control` are scaffolded, not implemented. Once they are, `dev:trading` runs the deterministic runtime against Postgres and the paper adapter, and `dev:control` serves the dashboard and control API. Every surface that shows state carries an unmistakable operating-mode banner — PAPER, SHADOW, PAUSED, or LIVE — so PAPER is never mistaken for a live-capable state.

## Environment variables

| Variable               | Purpose                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Postgres connection string, e.g. `postgresql://vigil:vigil_dev_password@localhost:5436/vigil_dev` |
| `VIGIL_MODE`            | Operating mode: `PAPER` (default), `SHADOW`, `PAUSED`, or `LIVE`                              |
| `LOG_LEVEL`             | pino log level, e.g. `info`                                                                   |
| `DATA_ROOT`             | Filesystem root for gitignored bulk market data under `data/`                                 |
| `CONTROL_PORT`          | Port `apps/control` listens on                                                                |
| `CONTROL_AUTH_SECRET`   | Signs/authenticates `apps/control` sessions and requests                                      |

`VIGIL_MODE=LIVE` alone never enables live trading — see [architecture.md](architecture.md#configuration-and-secrets).

## What never goes in `.env` or the repo

Venue API keys, RPC provider keys, LLM provider keys, signer private keys or seed material, personal portfolio holdings, and any personal planning notes. None of these exist in this repository today because no venue, chain, or LLM provider has been selected; when they exist, they are scoped to the single process that needs them ([architecture.md](architecture.md#configuration-and-secrets)). The repository's preflight hook refuses to stage `.env`.

## Commands

| Command              | Does                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| `pnpm lint`            | Type-aware ESLint across the workspace                                        |
| `pnpm lint:fix`        | `pnpm lint` with autofix                                                      |
| `pnpm lint:cycles`     | madge circular-import check                                                   |
| `pnpm typecheck`       | TypeScript project-wide type check, no emit                                   |
| `pnpm test`            | Pure suites (unit layer)                                                      |
| `pnpm test:int`        | Postgres-backed suites (integration layer)                                    |
| `pnpm jscpd`           | Copy-paste detection against the configured threshold                         |
| `pnpm db:up`           | Start the local Postgres container                                            |
| `pnpm db:down`         | Stop the local Postgres container                                             |
| `pnpm db:generate`     | Generate a Drizzle migration from schema changes                              |
| `pnpm db:migrate`      | Apply migrations                                                              |
| `pnpm db:studio`       | Drizzle Studio                                                                |
| `pnpm dev:trading`     | Run `apps/trading` in development                                             |
| `pnpm dev:control`     | Run `apps/control` in development                                             |

`pnpm test`, `pnpm test:int`, `pnpm lint`, and `pnpm typecheck` are CI-only on the development machine. The repository's preflight hook refuses to run them locally: CI is the only gate ([testing.md](testing.md#local-execution-boundary)), and several sessions share the same checkout, so a local run cannot claim to speak for the branch the way a CI run can.

## Where output goes

- `data/` — gitignored market recordings (Parquet/DuckDB)
- `eval-output/` — gitignored evaluation and task output, screenshots included
- `private/` — gitignored private notes

None of these are ever committed or referenced from `docs/`.

## Agent workflow

Agent roles, delegation, and review rules live in [AGENTS.md](../AGENTS.md).
