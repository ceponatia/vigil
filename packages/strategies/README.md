# @vigil/strategies

Deterministic strategy implementations. The first candidate is a single
numeric strategy producing a staged position plan — no LLM in the decision
loop, and no chasing: every entry carries a zone, an expiry, and an
invalidation.

## What it owns

- Deterministic candidate evaluation over market data from `@vigil/market`.
- Staged position plans: entry zone, expiry, invalidation, horizon, bounded
  tranche size, and a benchmark to compare against.
- WAIT / MISSED classification when an entry zone is no longer valid — a
  missed entry is never rewritten into a new BUY at the current price.

## What it must never do

- Perform IO of any kind (no network, no filesystem, no database).
- Call an LLM. A strategy in this package produces a numeric candidate on
  its own; explanation of catalysts and contradictions is a research
  concern, not a strategy concern.
- Place or simulate an order — that is `adapter-paper`'s (and later a live
  adapter's) job, invoked by `apps/trading`.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

## Allowed workspace imports

- `@vigil/contracts`
- `@vigil/market`

## Planned modules

- `candidate` — the numeric evaluation producing a directional candidate.
- `position-plan` — the staged plan: tranches, expiry, invalidation, horizon.
- `no-chasing` — the WAIT/MISSED reclassification rule for an expired zone.

## Status

Empty scaffold. First filled under planning ID BOOT-05.
