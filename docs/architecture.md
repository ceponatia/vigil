# Architecture

## Stack

| Layer               | Choice                                                                    | Why                                                                                                      |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime             | Node 24 LTS (`.node-version` `24.14.0`; `engines >=24`)                   | Current LTS; matches the pnpm/TypeScript agent workflow the repo runs on                                 |
| Package manager     | pnpm `11.26.0` (`packageManager` field)                                   | Workspace-aware installs across `apps/` and `packages/`                                                  |
| Language            | TypeScript `6.0.3`                                                        | One typed language across every package; type-aware lint catches boundary violations at lint time        |
| Test runner         | Vitest `5.0.0` + `@vitest/coverage-v8` `5.0.0`                            | One runner for pure suites and Postgres-backed suites                                                    |
| Lint                | ESLint `9.39.5` flat config + typescript-eslint `8.70.0` (type-aware)     | Zone-based import rules enforce the layer graph below                                                    |
| Schema / validation | zod `4.6.2`                                                               | Validates every provider, chain, and LLM response at its trust boundary ([resilience.md](resilience.md)) |
| ORM                 | Drizzle ORM `0.45.2` + drizzle-kit `0.31.10` + `pg` `8.23.0`              | SQL-first schema and migrations, one module per record family                                            |
| Database            | Postgres `18` (`postgres:18-alpine`, Docker Compose)                      | Durable financial and operational records with real transactions                                         |
| Cycle / duplication | madge `8.0.0`, jscpd `5.2.0`                                              | Catch import cycles and copy-pasted risk logic before merge                                              |
| Dev tooling         | tsx `4.23.13`, dotenv `17.4.2`, `@types/node` `24.13.4`                   | Script execution and env loading without a build step                                                    |
| Logging             | pino `10.3.1`                                                             | Structured logs; see [resilience.md](resilience.md)                                                      |
| Dashboard           | Next.js `16.3.4`, React / react-dom `19.3.0`, eslint-config-next `16.3.4` | `apps/control` only — a typed control surface, not the trading runtime                                   |
| CI building blocks  | `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`    | Pinned GitHub Actions primitives                                                                         |

Three upgrades are pending, not adopted:

- **TypeScript 7.** Its native compiler has shipped, but typescript-eslint `8.70` requires `<6.1.0`, so the toolchain stays on TypeScript `6.0.3` until typescript-eslint publishes a compatible major. Adopting TypeScript 7 early would mean linting without type-aware rules, which is a worse trade for this repository than waiting.
- **pnpm 12.** pnpm `12.4.1` exists; the workspace stays pinned to `11.26.0` until it has been verified against the rest of the pinned toolchain (lockfile format, workspace protocol behavior, CI action compatibility).
- **ESLint 10.** Released, but eslint-plugin-import, eslint-plugin-react, and eslint-plugin-jsx-a11y (dependencies of eslint-config-next) still declare an ESLint `<=9` peer range, so the toolchain stays on ESLint `9.39.5` and upgrades together with them.

## Repository layout

```text
package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json  # workspace + TS project config
vitest.config.ts eslint.config.mjs .jscpd.json                     # root test/lint/duplication config
drizzle.config.ts docker-compose.yml .env.example                  # migration + local Postgres + config template
.node-version .npmrc .editorconfig .gitattributes .gitignore       # toolchain pins and repo hygiene
.agents/skills/vigil-*/          # canonical skills (SKILL.md, references, templates, helper scripts)
.claude/ .codex/                 # per-harness agent config; hooks are canonical under .claude/hooks
apps/
  control/                       # Next.js dashboard + typed control API — reads Postgres, issues commands
  trading/                       # deterministic runtime: market engine, strategy engine, risk allocator,
                                  #   execution domain, durable outbox, reconciliation, ledger writer
packages/
  contracts/                     # zod schemas + types: identity, money, timestamps, packets, reason codes
  policy/                        # pure eligibility/risk/exposure/budget/permission checks — no IO, no LLM
  market/                        # asset/instrument/pool identity, quote snapshots, freshness, fixtures
  ledger/                        # multi-asset double-entry journal, holdings states, reservations
  strategies/                    # deterministic strategies
  adapter-paper/                 # paper execution adapter simulating an exchange order lifecycle
  db/                            # Drizzle schema (one module per record family) + pg client + migration glue
drizzle/                         # generated SQL migrations (drizzle-kit output)
scripts/                         # repository guard scripts — none yet
tests/
  fixtures/ replay/ fault-injection/   # cross-package suites and synthetic fixtures
docs/                            # this document and its siblings — see README.md
data/ eval-output/ private/      # gitignored: market recordings, evaluation output, private notes
```

The layout deliberately departs from a `services/`-style monorepo:

- Deployable processes live under `apps/`, not `services/`. Everything else is a library package.
- Venue adapters are flat `packages/adapter-<venue>` packages, not a nested `adapters/<venue>/` tree — each adapter is its own versioned, independently importable unit, and only one package (`adapter-paper`) exists today.
- Generated SQL migrations live at the repository root under `drizzle/`, not under an `infra/migrations/` tree, because `drizzle-kit` owns that directory directly.
- Operational runbooks live under `docs/runbooks/`, as documentation, not under an `infra/runbooks/` tree.
- There is no `infra/` directory yet. Local development runs on Docker Compose; no hosting target has been chosen, so there is nothing under `infra/` to hold.

## Layer graph and import rules

| Package         | May import                                                          | Enforced by                                          |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `contracts`      | nothing (pure)                                                        | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `policy`         | `contracts`                                                            | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `market`         | `contracts`                                                            | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `ledger`         | `contracts`                                                            | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `db`             | `contracts`                                                            | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `strategies`     | `contracts`, `market`                                                  | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `adapter-paper`  | `contracts`, `market`                                                  | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `apps/trading`   | `contracts`, `policy`, `market`, `ledger`, `strategies`, `adapter-paper`, `db` | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |
| `apps/control`   | `contracts`, `db`, `policy` only                                       | `eslint.config.mjs` zone; `lint:package-boundaries` (planned) |

Enforcement today is an ESLint zone configuration in `eslint.config.mjs`: `no-restricted-imports`-style rules per directory. A dedicated `lint:package-boundaries` script, resolving every import against the declared graph the way a spelling rule cannot, is planned and not built.

Three rules hold regardless of tooling:

1. **Packages never import apps.** The dependency direction is one-way: apps consume packages, never the reverse.
2. **Only `apps/trading` imports `adapter-*` packages.** `apps/control` and every package are barred from importing a venue adapter, because a venue adapter is where trade credentials live.
3. **LLM provider SDKs are permitted only in the future `apps/research`.** No package, no `apps/trading`, and no `apps/control` code imports an LLM provider SDK today, and none will after `apps/research` lands either.

## Process topology

| Process         | Holds                                                                        | Never holds                                                     | Status         |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------- |
| Postgres         | Durable financial/operational records: ledger, intents, orders, reservations, outbox, policies | Plaintext secrets, private keys                                    | running        |
| `apps/trading`   | One effective writer per financial authority domain; the paper adapter today, `adapter-<venue>` credentials later | LLM provider credentials; the ability to raise its own limits      | running (PAPER) |
| `apps/control`   | Read access to Postgres; the typed command/approval API                          | Venue credentials; signing keys; any `adapter-*` import             | running        |
| `apps/research`  | Evidence retrieval; LLM calls; thesis and proposal generation                    | Trade credentials; signing keys; limit-changing ability             | not built      |
| `apps/signer`    | Isolated venue/RPC signing credentials; policy-checked transaction authorization | Research or LLM access; the ability to originate a trade idea       | not built      |
| `apps/evaluation`| Backtests, labels, champion/challenger experiments                              | Live trade authority                                                | not built      |

## Data flow

```text
Market/quote feeds + chain/RPC data + route quotes
                    |
                    v
        Validated market/quote state (packages/market)
                    |
        +-----------+-----------------------------+
        |                                          |
  Deterministic strategy signals            Evidence + LLM thesis
  (packages/strategies)                     (apps/research — not built)
        |                                          |
        +-----------+-----------------------------+
                    |
                    v
     Portfolio / risk allocator (packages/policy + packages/ledger
                reservations, running inside apps/trading)
                    |
                    v
      Durable ApprovedEconomicIntent (packages/contracts, packages/db)
                    |
        +-----------+-----------------------------+
        |                                          |
  Exchange order adapter                 On-chain quote/simulation
  (packages/adapter-paper today;         + policy-checked signer
   packages/adapter-<venue> later)       (apps/signer — not built)
        |                                          |
     Exchange                              Approved chain
        |                                          |
        +-----------+-----------------------------+
                    |
                    v
     Orders / receipts / fills / balances (packages/db)
                    |
                    v
    Reconciliation + financial ledger (packages/ledger)
                    |
                    v
   Outcome and counterfactual evaluation (apps/evaluation — not built)
```

## Components and boundaries

**Control application (`apps/control`).** An authenticated dashboard and typed API. It reads Postgres and issues commands — research configuration, approvals, limits, reports, administrative controls. It never returns a retrievable private key or trading secret in an ordinary API response, and it never imports an `adapter-*` package.

**Market/quote engine (`packages/market`).** Owns identity mapping, instruments/pools, order books or executable quotes, trades, bars, status, metadata, freshness, and health. A last-trade price is data, not a guarantee that the same price is executable at the desired size.

**Research worker (`apps/research`, not built).** Approved retrieval, evidence packets, LLM calls, thesis generation, and critical review, once it exists. It never holds an exchange trading key, a wallet seed, a signing capability, or an unrestricted production shell.

**Strategy engine (`packages/strategies`).** Approved numerical strategies and condition monitoring. It never depends synchronously on an LLM for immediate entry validation or existing risk management.

**Portfolio/risk allocator (`packages/policy` + `packages/ledger`, running inside `apps/trading`).** Account/wallet-aware capital, global exposure, reservations, eligibility, cost checks, sizing, funding sources, and intent creation. Two strategies never reserve the same capital independently — the allocator is the only path to a reservation.

**Execution domain (`apps/trading` + `packages/adapter-paper`, `packages/adapter-<venue>` later).** One effective writer per financial authority domain, coordinated under the allocator. Exchange orders and on-chain transactions keep separate lifecycles ([Execution lifecycles](#execution-lifecycles)) rather than being forced into one abstraction.

**Isolated signer (`apps/signer`, not built).** Separately protected secrets and deterministic policy checks over the actual transaction, once it exists. Research can request an action; only this boundary authorizes a compliant transaction.

**Treasury.** Location of capital, approved settlement tokens, gas reserves, transfer status, funding/withdrawal holds, and route support. Initial funding is manual. A treasury transfer between controlled locations is never conflated with a trade. Today, treasury records are a `packages/db` schema module ([Record families](#record-families)); a dedicated treasury component is not built.

**Evaluation worker (`apps/evaluation`, not built).** Outcomes, backtests, simulations, point-in-time datasets, model training, experiments, comparisons, and promotion evidence, once it exists. It never holds live trade authority.

## Record families

| Record family                                                        | Purpose                                                                   | Module        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------- |
| Assets, instruments, chains, contracts, pools, exposure links           | Canonical identity, capabilities, token representations, economic exposure   | `assets`      |
| Venues, custody domains, accounts, wallets, credential references       | Where money is held and which limited authority can operate it               | `venues`      |
| Source documents, evidence versions, market/quote/feature snapshots     | Point-in-time reproducibility and input provenance                           | `evidence`    |
| Theses, proposals, candidate events, position plans                     | Every decision, including WAIT, rejected, expired, and missed entries        | `decisions`   |
| Policies, strategy versions, model/prompt versions                      | Immutable behavior and approval history                                      | `policies`    |
| Reservations, approved intents, outbox                                  | Capital authority and durable dispatch                                       | `intents`     |
| Orders, order events, fills                                             | Exchange execution lifecycle                                                 | `orders`      |
| Transaction attempts, simulations, signatures/hashes, receipts, chain events | On-chain lifecycle and reconciliation — never a plaintext signing secret | `transactions`|
| Journal entries, balances, lots, valuations                             | Multi-asset accounting, basis provenance, cash-flow-adjusted performance     | `journal`     |
| Yield strategies, allocations, claims, allocation events                | Deposited, locked, redeeming, reward, and exit-queue states                  | `yield`       |
| Treasury transfers, network support, gas reserves                       | Capital location, future transfers, receipt confirmation, stranded capital  | `treasury`    |
| Outcomes, counterfactuals, experiments                                  | Mature labels and reproducible comparisons                                   | `outcomes`    |
| Incidents, heartbeats, permission audits, budgets                       | Operational health, authority, and expense limits                            | `ops`         |

A record family's presence in this table is not an instruction to create every table before the first paper trade — schema grows with the vertical slice that needs it.

## Contracts

The following are application contracts, not exact exchange, chain, router, or LLM-provider API schemas. They are conceptual, refined once the first venue/chain is selected. Every cross-boundary quantity or price is a decimal string or an exact integer base unit, never a floating-point number. Every provider, chain, and LLM response is validated against these application-owned schemas before use ([resilience.md](resilience.md)).

```typescript
type ResearchPacket = {
  id: string;
  assetId: string;
  asOf: string;
  sources: Array<{
    evidenceId: string;
    publisher: string;
    publishedAt: string | null;
    firstSeenAt: string;
    contentHash: string;
    trustClass: "primary" | "independent" | "sentiment";
  }>;
  featureSnapshotId: string;
  marketSnapshotId: string;
  portfolioSnapshotId: string;
  missingInputs: string[];
  eligibleForExecution: boolean;
};

type TradeProposal = {
  proposalId: string;
  researchPacketId: string;
  thesisId: string;
  assetId: string;
  action: "BUY" | "ADD" | "HOLD" | "TRIM" | "EXIT" | "WAIT" | "AVOID";
  actionDetail: string; // preserves MISSED_ENTRY / WAIT as distinct from a plain WAIT
  horizon: "intraday" | "swing" | "position";
  entryZone: { min: string; max: string } | null;
  expiresAt: string;
  invalidationConditions: string[];
  evidenceIds: string[];
  strongestBearCase: string;
  missingInformation: string[];
  requestedStrategyId: string;
  candidateVenueIds: string[];
};

// Extends a validated TradeProposal. Immutable once approved, consumable
// exactly once economically.
type ApprovedEconomicIntent = TradeProposal & {
  intentId: string;
  policyVersion: string;
  strategyVersion: string;
  modelVersion: string | null; // null when no LLM was involved
  portfolioSnapshotVersion: string;
  marketSnapshotVersion: string;
  feeSnapshotVersion: string;
  economicActionId: string;
  positionPlanId: string;
  idempotencyKey: string;
  correlationId: string;
  fundingAccountId: string;
  reservedAssets: Array<{ assetId: string; quantity: string }>;
  venueId: string;
  chainId: string | null;
  routeId: string | null;
  inputAssetId: string;
  outputAssetId: string;
  quantity: string;
  maxSpend: string;
  minAcceptableReceipt: string;
  permittedResidual: string;
  validUntil: string;
  requiredFreshnessMs: number;
  protectionPlan: string | null;
  remainingInventoryTreatment: string;
  benchmarkId: string | null;
  approvalReason: string | null;
  rejectionReasonCode: string | null;
  adapterCapabilityVersion: string;
  chainValidation: { simulationId: string; simulationPassed: boolean } | null;
};
```

The LLM never supplies authoritative available cash, final size, loss limits, fee rates, slippage limits, signing permissions, or calibrated execution probabilities. A research packet can be valid for analysis while `eligibleForExecution` is false. Reason codes are defined in [policy.md](policy.md).

## Execution lifecycles

### Exchange

```text
PROPOSED -> VALIDATED -> RESERVED -> SUBMITTING -> ACKNOWLEDGED
                                            \-> UNKNOWN
ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED
ACKNOWLEDGED / PARTIALLY_FILLED -> CANCEL_PENDING -> CANCELED
SUBMITTING / ACKNOWLEDGED -> REJECTED or EXPIRED only when confirmed
UNKNOWN -> reconciliation -> confirmed exchange state
```

### On-chain

```text
PROPOSED -> QUOTED -> SIMULATED -> POLICY_VALIDATED -> RESERVED
                                                        |
                                                     SIGNING
                                                        |
                                                    BROADCAST
                                                        |
                                              PENDING or UNKNOWN
                                                        |
                                       INCLUDED -> FINALIZED / CONFIRMED
```

Rejected, expired, failed/reverted, replaced, dropped, and reorganized states follow the selected chain's own rules once one is selected; no chain's notion of finality, nonce, blockhash expiry, or safe cancellation is assumed to match another's.

Four rules hold across both lifecycles:

- **UNKNOWN is a state, not a failure.** An ambiguous outcome is never resolved by assumption. A submission or broadcast timeout produces the UNKNOWN state itself. A cancellation timeout produces an UNKNOWN *attempt* result while the order stays in the state that already means the cancellation was requested and not confirmed — `CANCEL_PENDING` in the Exchange lifecycle — because an unconfirmed cancellation has neither taken effect nor been refused. Either way the order releases nothing and accepts no further operation until reconciliation resolves it.
- **Reconciliation precedes resubmission.** Open orders, transaction history, executions, and balances are reconciled against the venue or chain before any resubmission, replacement, or cancellation retry.
- **Retries are versioned attempts on the same intent**, never a new authorization to repeat the trade. An `ApprovedEconomicIntent` is immutable and consumable once.
- **One effective writer, fenced.** Exactly one process holds dispatch/signing authority per financial authority domain at a time. A failover fences the old writer before the new one dispatches; a database lease alone is insufficient if a stale process can still submit.

## Cadence

| Work                                                     | Behavior                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Instrument, pool, token, and route capability metadata      | Startup, material status changes, and periodic verification                                  |
| Broad numerical screen                                       | Stream aggregation plus periodic ranking; no LLM call per asset/tick                          |
| Active candidates and positions                              | Event-driven updates appropriate to the venue and horizon                                    |
| Final eligibility / cost / risk / freshness checks           | Every submission, amendment, signing request, or material state change                        |
| Technical features                                            | Event aggregation and roughly 1–5-minute refreshes where appropriate; completed bars only     |
| LLM research                                                  | Material news or candidate-state change; deduplicated and cached                              |
| Deep thesis refresh                                           | Event-driven; more often for active ideas, much less often for unchanged longer-horizon ideas |
| Yield review                                                   | Daily and on rate, liquidity, security, or support changes; position monitoring as available  |
| Outcome labels                                                 | Only after their predeclared horizon or terminal event matures                                |
| Candidate-model evaluation                                     | Scheduled batches with sufficient mature evidence; retraining is not promotion                |

Research or provider failure never disables existing deterministic risk management. Invalid market/account/chain state blocks new risk. If a durable record cannot be written, no new economic action proceeds ([resilience.md](resilience.md)).

## Storage

Postgres holds financial and operational records: the journal, intents, reservations, orders, transactions, policies, and outbox — everything that must be transactional and durable. Parquet plus DuckDB under `data/` hold bulk market history: order book snapshots, quotes, and bars kept for replay and offline analysis. Every order-book update never lands in Postgres; that volume belongs under `data/`.

## Configuration and secrets

| Variable               | Purpose                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Postgres connection string read by `apps/trading`, `apps/control`, and `packages/db` migration glue |
| `VIGIL_MODE`            | Operating mode: `PAPER` (default), `SHADOW`, `PAUSED`, or `LIVE`                              |
| `LOG_LEVEL`             | pino log level                                                                                |
| `DATA_ROOT`             | Filesystem root for gitignored bulk market data (Parquet/DuckDB) under `data/`                |
| `CONTROL_PORT`          | Port `apps/control` listens on                                                                |
| `CONTROL_AUTH_SECRET`   | Signs/authenticates `apps/control` sessions and requests — never a venue or signing credential |

`VIGIL_MODE=LIVE` alone never enables live trading; LIVE sits behind a capability gate that no environment variable can open.

No venue, RPC, or LLM-provider secret exists yet, because no venue, chain, or LLM provider has been selected. When they do, each is scoped to the process that needs it and nowhere else: a venue or RPC credential is read only inside its `packages/adapter-<venue>` package, imported only by `apps/trading`; an LLM provider credential is read only inside the future `apps/research`; signer key material is read only inside the future `apps/signer`, isolated from `apps/trading` and administered outside the trading agent. `apps/control` holds none of these.

The repository's preflight hook refuses to stage `.env` (or any file the ignore rules mark as secret-bearing), so a secret cannot enter a commit even by accidental staging.

## Not built

- `apps/research`, `apps/signer`, `apps/evaluation` — planned processes, none exist
- Any `packages/adapter-<venue>` beyond `adapter-paper` — no venue or chain is selected
- `scripts/` guard scripts — none exist; [runbooks/README.md](runbooks/README.md) and this document name the planned ones
- `lint:package-boundaries` — the layer graph is enforced only by ESLint zones today
- The `LIVE` capability gate implementation
- A dedicated treasury component — treasury records exist only as a `packages/db` schema module
- The Python (`uv`) evaluation/ML worker — a reserved seam, not created
- Candidate libraries named but not installed: viem, `@solana/kit`, hono, `@duckdb/node-api` and its Parquet tooling, big.js/decimal.js, better-auth, ccxt

See [decisions/README.md](decisions/README.md) for the decisions that remain open, [policy.md](policy.md) for reason codes and eligibility rules, [capabilities.md](capabilities.md) for verified/unsupported venue behavior, and [testing.md](testing.md) for how each of these claims gets verified once built.
