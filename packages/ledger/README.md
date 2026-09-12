# @vigil/ledger

The multi-asset double-entry journal: holdings states, atomic reservations,
and the reconciliation math that proves the journal still balances against
external truth. It is pure arithmetic over data callers supply — it never
reads or writes a database itself.

## What it owns

- The double-entry journal model (balancing entries; no unbalanced posting).
- Holdings states: free, reserved, locked, pending, unbonding, external.
- Atomic reservations (no concurrent overspend of a shared balance).
- Reconciliation math against exchange/wallet/chain state at a consistent
  event watermark.

## What it must never do

- Perform IO of any kind (no database, no exchange calls, no chain reads —
  `packages/db` persists what this package computes).
- Call an exchange or a chain directly.
- Treat a deposit as profit, a transfer between controlled locations as new
  capital, or a pending transaction as a finalized outcome.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

## Allowed workspace imports

- `@vigil/contracts`

## Planned modules

- `journal` — the double-entry model and balancing invariant.
- `holdings-states` — free/reserved/locked/pending/unbonding/external.
- `reservations` — atomic reserve/release against a holdings state.
- `reconciliation` — the watermark-consistent reconciliation math.

## Status

Empty scaffold. First filled under planning ID BOOT-04.
