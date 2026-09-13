# @vigil/control

The Next.js dashboard and typed control API. It reads the database and
issues commands; it never holds venue or signing credentials and never
imports an adapter package.

## Purpose

The dashboard exists to answer five questions without requiring anyone to
inspect internal agent chats:

- **What do I own?** Confirmed holdings, free/reserved/locked/pending
  balances, economic exposures, gas reserves, realized/unrealized results.
- **Why is it acting?** The current executable entry, zone validity, thesis,
  strongest opposing case, horizon, size, expected costs, and invalidation —
  distinguishing "discovered" from "approved and executable".
- **What is protecting the capital?** Limits, correlated exposure, drawdown,
  stale state, unresolved orders/transactions, and current operating mode.
- **Is it improving?** Executed/rejected/missed cohorts, avoided losers,
  benchmark-relative results, cost sensitivity, and calibration.
- **What is it costing?** Fees, slippage, gas, failed transactions, model
  calls, RPC/data, and hosting — separately and together.

## Proposed views

Overview; Opportunities; Positions; Yield; Treasury/Venues; Learning;
Audit/Controls.

## The mode banner

PAPER / SHADOW / LIVE / PAUSED must be displayed unmistakably on every view —
never a small badge that can go unnoticed. Capability status and unsupported
features are shown explicitly rather than the dashboard pretending every
venue works alike.

## What it never holds

- Venue or signing credentials, in any form.
- An LLM provider key. Research and proposal generation happen in a
  separate app; the dashboard reads their output from the database.
- A dependency on `@vigil/market`, `@vigil/ledger`, `@vigil/strategies`, or
  any `@vigil/adapter-*` package — its workspace surface is limited to
  `@vigil/contracts`, `@vigil/db`, and `@vigil/policy`
  (`docs/architecture.md` "Layer graph and import rules").

## Status

The Overview page exists (planning ID BOOT-07): the mode banner on every
surface, and Holdings, Reservations, Candidates, Costs, an Audit trail, and
Runtime health, all read from `@vigil/db` — no mock or static data. A stale
heartbeat or quote, and a paused runtime instance, are shown explicitly
rather than hidden. An invalid `VIGIL_MODE`, a missing `DATABASE_URL`, or a
failed read renders a full-page error instead of an empty dashboard.
Opportunities, Positions, Yield, Treasury/Venues, Learning, and
Audit/Controls remain planned, and this slice issues no commands: no
approvals UI, no controls, and no authentication provider yet.
