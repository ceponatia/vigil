# @vigil/adapter-paper

A paper execution adapter that simulates the exchange order lifecycle with
explicit, realistic costs. It is the only execution adapter until a venue is
selected, and the convention it establishes — `packages/adapter-<venue>` —
is how a live adapter joins the workspace later.

## What it owns

- Simulated order lifecycle: submit, acknowledge, partial fill, fill,
  cancel, reject, expire.
- Explicit simulated costs: fees, slippage, and any modeled latency.
- Deterministic, reproducible outcomes for a given input — a replay of the
  same intent against the same recorded market data produces the same fills.

## What it must never do

- Touch a live venue endpoint. There is no code path in this package that
  reaches a real exchange, wallet, or chain — that is what makes it safe for
  every environment, including CI, to exercise the full order lifecycle.
- Hold a real credential of any kind.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

Only `apps/trading` may import this package (or any future
`packages/adapter-<venue>`) — see `docs/architecture.md` "Layer graph and
import rules".

## Allowed workspace imports

- `@vigil/contracts`
- `@vigil/market`

## Planned modules

- `order-lifecycle` — the simulated state machine from submit to terminal.
- `costs` — the fee and slippage model applied to a simulated fill.
- `outcomes` — unknown/duplicate/partial outcome handling on top of the
  lifecycle.

## Status

Empty scaffold. First filled under planning ID BOOT-06.
