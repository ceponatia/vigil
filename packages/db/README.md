# @vigil/db

The Drizzle schema, one module per record family, plus the Postgres client
factory and migration glue that the rest of the workspace uses to persist
what `@vigil/ledger`, `@vigil/policy`, and the trading runtime compute.

## What it owns

- One schema module per record family (listed below).
- The pg client factory (connection creation from `DATABASE_URL`, pooling).
- Migration glue consumed by the root `db:generate` / `db:migrate` scripts.

## What it must never do

- Hold a secret as a column. A credential reference (which venue, which
  account) may be a row; the credential material itself never is.
- Contain eligibility, risk, or business logic — that is `@vigil/policy`'s
  job. This package persists and retrieves; it does not decide.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`);
  monetary columns store decimal strings or integer base units, never a
  floating-point column type.

## Allowed workspace imports

- `@vigil/contracts`

## Schema modules

- `assets` — canonical asset/instrument/chain/contract/pool identity,
  capabilities, token representations, and economic exposure links.
- `venues` — where money is held and which limited authority can operate it:
  venues, custody domains, accounts, wallets, and credential references.
- `evidence` — point-in-time reproducibility and input provenance: source
  documents, evidence versions, and market/quote/feature snapshots.
- `decisions` — every decision, including WAIT, rejected, expired, and
  missed entries: theses, proposals, candidate events, and position plans.
- `policies` — immutable behavior and approval history: policies, strategy
  versions, and model/prompt versions.
- `intents` — capital authority and durable dispatch: reservations,
  approved intents, and the outbox.
- `orders` — exchange execution lifecycle: orders, order events, and fills.
- `transactions` — on-chain lifecycle and reconciliation: transaction
  attempts, simulations, signatures/hashes, receipts, and chain events.
  Never stores plaintext signing secrets.
- `journal` — multi-asset accounting: journal entries, balances, lots, and
  cash-flow-adjusted valuations.
- `yield` — deposited, locked, redeeming, reward, and exit-queue states:
  yield strategies, allocations, claims, and allocation events.
- `treasury` — capital location and movement: treasury transfers, network
  support, gas reserves, and stranded-capital visibility.
- `outcomes` — mature labels and reproducible comparisons: outcomes,
  counterfactuals, and experiments.
- `ops` — operational health, authority, and expense limits: incidents,
  heartbeats, permission audits, and budgets.

Logical record families are not an instruction to create every table before
the first paper trade — normalize around the first vertical slice and extend
as later slices need to.

## Status

Empty scaffold. First filled under planning ID BOOT-04, with individual
schema modules landing per the record family a given slice needs.
