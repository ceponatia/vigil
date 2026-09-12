# @vigil/ledger

The multi-asset double-entry journal: holdings states, atomic reservations,
and the reconciliation math that proves the journal still balances against
external truth. It is pure arithmetic over data callers supply — it never
reads or writes a database itself.

## What it owns

- The double-entry journal model. Every entry balances **per asset**; a swap
  balances each leg against the `exchange` clearing account rather than
  across two assets, because valuing one asset in another needs market data
  this package may not have.
- Append-only correction: a mistake is fixed by posting a reversing entry
  and then the corrected entry. No function here edits or deletes a posted
  entry, and `packages/db` enforces the same rule with a trigger. A reversal
  must be the exact inverse of the entry it names — same accounts, scales,
  and amounts, opposite sides — because it also consumes that entry's one
  correction slot.
- Reservation postings are the exact state move they name: a hold credits
  `available` and debits `reserved`, a release does the inverse, and nothing
  else is a reservation posting at all.
- Holdings states: available, reserved, staked, unbonding, pending-transfer,
  and exit-queued, as six distinct values (`docs/product.md` TASK-07). Only
  `available` is reservable. Each refusal carries the code an operator needs
  (owner ruling, 2026-09-12): `YIELD_LOCKED` for staked and unbonding,
  `TRANSACTION_UNRESOLVED` for funds in flight between locations, and the
  ledger-local `STATE_NOT_RESERVABLE`, naming the state, for a balance
  already committed to another intent or queued for exit.
- Asset identity is `@vigil/contracts`' `AssetId` — the canonical
  `chainId|kind|value|withdrawalNetwork` form `canonicalAssetId` derives,
  imported rather than restated, so a ledger account and a market quote are
  keyed by the same type. Never a bare ticker, because `BTC` names a
  different asset on every chain that lists one. Account keys are
  `family/state/assetId`: `/` separates them because it is the one character
  an asset identity may not contain.
- Provenance on every record: the policy and strategy versions that produced
  it, the model version where an LLM was involved, and the market and
  portfolio snapshot versions where those informed it. An outcome that
  cannot be attributed to the behavior that caused it teaches nothing.
- Atomic reservations against a supplied balance sheet: a reservation may
  consume only `available`, and the second of two reservations whose sum
  exceeds the balance is refused with a reason code. Serializing two
  concurrent processes is the store's job, not this package's.
- Exact base-unit arithmetic: `bigint` base units beside an explicit
  per-asset scale, converted to and from the `DecimalString` wire type at
  this package's edge.
- Cash-flow-adjusted performance: contributions are basis, never profit, so
  a deposit cannot move the high-water mark or the drawdown measured from
  it.
- Rebuilding balances from the journal alone, and comparing a rebuilt
  balance sheet against a stored one.

## What it must never do

- Perform IO of any kind (no database, no exchange calls, no chain reads —
  `packages/db` persists what this package computes).
- Read a clock. Every timestamp is an input, so a replay of the same journal
  always produces the same answer.
- Call an exchange or a chain directly.
- Treat a deposit as profit, a transfer between controlled locations as new
  capital, or a pending transaction as a finalized outcome.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).
- Decide policy. It reports the drawdown figure; the threshold, the pause,
  and the authority to lift one belong to `packages/policy`.

## Allowed workspace imports

- `@vigil/contracts`

## Modules

- `accounts` — account families, the six holdings states, which of them a
  reservation may consume, and the canonical account key.
- `base-units` — exact conversion between `DecimalString` and `bigint` base
  units at a given scale; refuses rather than rounds.
- `balances` — the balance projection, the rebuild from an empty state, and
  balance-sheet comparison.
- `diagnostics` — the ledger's own refusal vocabulary, kept distinct in type
  and name from the policy reason codes in `docs/policy.md`.
- `journal` — the entry model, the balancing invariant, the entry-kind and
  account-family rules, and reversing entries.
- `performance` — contributed basis, realized P&L net of fees, the
  high-water mark, and the drawdown measured from it.
- `reservations` — planning a hold or a partial release against a balance
  sheet.
- `timestamps` — pure age and ordering arithmetic. The format, the UTC-only
  rule, the calendar check, and the at-most-milliseconds precision cap are
  `@vigil/contracts`', shared with every other consumer of a `timestamptz(3)`
  column; what stays here is which stages a ledger record carries
  (`occurredAt`, `recordedAt`, `expiresAt`).

Reconciliation against exchange, wallet, and chain state at a consistent
event watermark is not built; `compareBalanceSheets` is the piece of it that
exists.

`RESERVATION_STATES` declares the lifecycle a hold will follow —
`active → released | consumed | expired` — and this package moves a hold
through none of it. `planRelease` computes the posting that returns capital
to `available`, but which outcome releases, consumes, or expires a
reservation is execution-lifecycle knowledge: a partial fill releases only
the confirmed unfilled remainder, and guessing that rule before the
execution slice owns it would be a wrong rule written down durably. The
vocabulary is declared now so the states exist to transition to.
