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

## Column conventions

- **Money and quantities** are `numeric(78, 0)` — an exact integer count of
  base units — beside an `asset_scale` column that says how many decimal
  places those units represent. 78 digits hold a 256-bit integer, so an
  18-decimal token balance cannot overflow the column the way an 8-byte
  `bigint` would. No column is `real` or `double precision`.
- **Timestamps** are `timestamptz(3)`: millisecond precision, matching what
  an ISO-8601 timestamp carries, so a stored instant is always one the
  application can read back and replay exactly.
- **Idempotency keys are unique**, enforced by unique indexes — an
  idempotency key that is merely indexed stops nothing. Correlation ids are
  deliberately *not* unique: one correlation id ties an intent, its attempts,
  and its outcome together, so it is indexed for lookup and nothing more.
- **Journal tables are append-only.** A trigger rejects every `UPDATE` and
  `DELETE` against a posted entry or posting; a correction is a reversing
  entry. `ledger_balances` is a projection of the journal and is updated in
  place.
- **Vocabularies are Postgres enums**, so a column cannot hold a holdings
  state, account family, entry kind, or reservation state that does not
  exist.

## Forward-declared seams

- **The reservation lifecycle.** `reservation_state` declares
  `active → released | consumed | expired`, and only `active` is ever
  written: nothing releases, consumes, or expires a hold yet, and
  `expires_at` is stored but never read. The values and the column exist now
  so the execution slice that owns those transitions changes behavior rather
  than the schema — and so the partial unique index that allows one live
  hold per intent already has the terminal states it will need.
- **Asset identity.** `asset_id` is canonical-id text with no foreign key;
  the `assets` record family and the key arrive with the slice that creates
  it.

## Built modules

`journal` (journal entries, postings, and the balance projection) and
`intents` (reservations) exist, with the baseline migration under
`drizzle/`. The remaining record families above are created by the slice
that needs them.
