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
- **An approved intent is immutable, and consumable exactly once.** The
  `intent_lifecycle_guards` trigger rejects every `UPDATE` and `DELETE`
  against `approved_intents` — total rather than a list of authorizing
  columns, since a list has to be maintained and the column nobody adds to it
  is the one that stays mutable. Its lifecycle lives on `execution_attempts`
  instead: one row per attempt number, at most one live attempt per intent
  (with `UNKNOWN` counted as live, so reconciliation precedes resubmission),
  and at most one attempt per intent that ever spends anything. A remainder
  after a partial fill is a new intent, not a further attempt on the old one.
- **An approved intent carries the economics that passed policy.** The
  quote it was decided on and when that quote was acquired, the cost-model
  version, the numeraire, the notional, the expected gross, the expected
  total cost, the expected net edge and the minimum it had to reach are
  `NOT NULL` columns on the intent — not a 1:1 side table, which could be
  absent. Check constraints hold net edge to gross less cost and refuse an
  intent that does not reach its own hurdle; a deferred constraint trigger
  requires the named cost components to sum to that total. Each component
  records whether it is embedded in the execution price or charged
  separately, so a later evaluation cannot count an embedded cost twice, and
  carries both its native amount and its value in the numeraire with a named
  `conversion_source` whenever those assets differ — no total here is ever a
  sum of amounts in different assets. `minimum_net_edge_base` is null
  exactly when `net_edge_basis` says the decision was exempt, which is what a
  protective unwind is.
- **A dispatch is durable before it happens.** An outbox row is enqueued
  `pending` — the trigger refuses an insert in any other state — and it
  points at an attempt, which points at an approved intent, so a dispatch
  with no authorization behind it has nowhere to be written. It carries a
  SHA-256 digest of the payload rather than the payload, and a fencing token
  that can never go backwards, so a writer that has been fenced cannot mark a
  dispatch it no longer owns. That token is necessary and not sufficient:
  fencing must remove the outgoing writer's real capability at the venue,
  which no column can do.
- **Candidates are append-only.** The same kind of trigger guards
  `candidates` and `candidate_tranches`: a candidate is the record of what
  was believed *before* the outcome was known, so a later judgement is an
  appended `candidate_evaluations` row and never an edit — which is what
  keeps a missed entry a MISSED rather than a rewritten BUY.
- **Decision prices and quantities are decimal text.** A candidate's entry
  zone, tranche quantity, or observed bid records what was decided rather
  than money that moved: nothing in this package adds them up, and no
  `asset_scales` row is needed to interpret them. They are `text` columns
  constrained to `@vigil/contracts`' decimal-string shape without its sign —
  no exponent, no leading zeros, no trailing bare `.`, nothing negative — so
  a float artifact has nowhere to land. Base units and `asset_scale` stay
  with the journal, where the arithmetic happens.
- **Vocabularies are Postgres enums**, so a column cannot hold a holdings
  state, account family, entry kind, or reservation state that does not
  exist.
- **One asset has one scale.** `asset_scales` registers it on first use, and
  every table that stores base units carries a composite
  `(asset_id, asset_scale)` foreign key into it, so base units at a second
  scale have nowhere to point. The same table's check constraint is where a
  bare ticker is refused: every asset id in the ledger points at a row here,
  so one constraint covers all of them.
- **Every economic record carries its provenance**: the policy and strategy
  versions that produced it (required, non-blank, enforced by a check
  constraint), the model version (null when no LLM was involved), and the
  market and portfolio snapshot versions (null when none informed it).
- **A posted entry is sealed.** Postings may be added only by the
  transaction that wrote the entry, so a later writer cannot add offsetting
  lines that change what a committed entry says while leaving the balance
  projection untouched.

## Forward-declared seams

- **The reservation's authorization.** `reservations.intent_id` carries no
  foreign key into `approved_intents` yet. It should — capital held for an
  authorization nobody wrote down is exactly what this family refuses
  everywhere else — but adding one changes the call order of a merged,
  tested path, since `reserveAvailable` would begin refusing every caller
  that has not persisted its intent first. That is the execution slice's
  contract to settle.
- **The venue's own order.** An execution attempt is the intent-side record
  of one try at consuming an authorization: which attempt, what state, how
  much of the authorization it consumed. The venue's order object, its
  events, and its individual fills are the `orders` family, which arrives
  with the slice that needs them and references the attempt.
- **The reservation lifecycle.** `reservation_state` declares
  `active → released | consumed | expired`, and only `active` is ever
  written: nothing releases, consumes, or expires a hold yet, and
  `expires_at` is stored but never read. The values and the column exist now
  so the execution slice that owns those transitions changes behavior rather
  than the schema — and so the partial unique index that allows one live
  hold per intent already has the terminal states it will need.
- **Asset identity.** `asset_id` is canonical-id text, checked against the
  `chainId|kind|value|withdrawalNetwork` shape in `asset_scales` and pointed
  at by every table that stores base units. `asset_scales` is the first
  column of the `assets` record family; when that family lands with
  identity, capabilities, and token representations, this table folds into
  it and the foreign keys point there instead.

## Built modules

- `journal` — journal entries, postings, and the balance projection.
- `intents` — reservations, approved intents with their
  `intent_cost_components` breakdown, the versioned execution attempts that
  consume them, and the dispatch outbox. An attempt carries no
  asset ids and no provenance of its own: both are the intent's, reached
  through a `NOT NULL` foreign key that cannot be absent, and a second copy
  would be a second answer that can disagree with the authorization. It does
  carry the two scales so its amounts are interpretable from the row itself,
  and the lifecycle trigger refuses an attempt whose scales are not the
  intent's. `ApprovedEconomicIntent`'s `rejectionReasonCode` is deliberately
  not a column here — a row in `approved_intents` exists only because policy
  approved, and a refusal is a `candidate_evaluations` row in the `decisions`
  family — and its `reservedAssets` array is the `reservations` rows naming
  that intent rather than a list that could disagree with the holds taken.
- `decisions` — candidates, their staged position-plan tranches
  (`candidate_tranches`), and the evaluations that later judge them
  (`candidate_evaluations`, whose `NOT NULL` foreign key is what makes an
  outcome without its candidate unrepresentable). An evaluation carries no
  correlation id or provenance columns of its own: it inherits both through
  that foreign key, which cannot be null, so there is one place a judgement's
  provenance is written and no second copy to disagree with it. Theses and
  research proposals arrive with the slice that produces them.
- `ops` — heartbeats. Incidents, permission audits, and budgets arrive with
  the slices that own them.

Their migrations are under `drizzle/`. The remaining record families above
are created by the slice that needs them.
