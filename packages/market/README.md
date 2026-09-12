# @vigil/market

Asset, instrument, and pool identity, plus the market and quote snapshots
built from them: freshness and validity rules, synthetic fixtures for
deterministic tests, and recording of what was observed and when.

## What it owns

- Instrument/pool identity built on `@vigil/contracts`' asset identity.
- Market and quote snapshot shapes, tied to the timestamp family.
- Freshness/validity rules (a stale quote is not an executable one).
- Synthetic, deterministic market fixtures for tests and replay.
- Recording of observed market/quote data for reproducibility.

## What it must never do

- Hold venue credentials or place an order — that is `adapter-paper`'s (and
  later a live adapter's) job, and only `apps/trading` may wire one in.
- Perform live network IO on its own initiative; a read-only live adapter,
  when one exists, is a caller that hands this package data, not something
  this package reaches out for itself.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

## Allowed workspace imports

- `@vigil/contracts`

## Planned modules

- `instrument-identity` — instrument/pool identity on top of asset identity.
- `quote-snapshot` — point-in-time market/quote data shapes.
- `freshness` — validity and staleness rules over the timestamp family.
- `synthetic-fixtures` — deterministic, reproducible market data for tests.
- `recording` — capturing observed data for replay and reproducibility.

## Status

`instrument-identity`, `quote-snapshot`, `freshness`, and the seeded
synthetic feed (`synthetic-feed` — this package's `synthetic-fixtures`
module) exist, covering exactly one synthetic instrument/route
(planning ID BOOT-03). `recording` remains planned. This package includes
no read-only adapter: no venue has a capability record yet, and this
package performs no live network IO on its own initiative (see "What it
must never do" above).
