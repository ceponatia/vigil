# @vigil/trading

The deterministic trading runtime: market engine, strategy engine,
portfolio/risk allocator, execution domain (the paper adapter today), a
durable outbox, reconciliation, and the ledger writer. It is where every
workspace package meets and acts — the layer graph gives it access to
everything (`apps/trading ← everything`, `docs/architecture.md` "Module
dependency rules") precisely because it is the one place authorized to.

## The single-writer rule

One effective writer per financial authority domain. Two independent code
paths — a buy strategy and a sell strategy, a scheduled rebalance and a
manual override — never independently mutate the same reservation, holding,
or intent. Every mutation to a given domain goes through this runtime's one
writer for that domain, so nothing can race itself.

## Operating modes

PAPER is the default and requires no capability gate. SHADOW runs the full
decision pipeline without capital at risk. LIVE sits behind an explicit
capability gate from `@vigil/policy` and is never enabled by an environment
variable alone (`VIGIL_MODE=LIVE` in `.env` does nothing but refuse to
start). PAUSED halts new risk while continuing to protect existing
positions — fail closed on financial authority, but never block a
protective action.

## What it may hold

Venue credentials and read-only market credentials, once a venue is
selected, live here — this is the process with execution authority. It must
never hold an LLM provider key: research and proposal generation happen
elsewhere, and nothing that can move money also calls a model provider.

## Planned module directories

- `market/` — live market/quote ingestion feeding `@vigil/market`'s shapes.
- `strategy/` — invocation of `@vigil/strategies` candidates on a schedule.
- `allocator/` — portfolio/risk allocation across concurrent candidates.
- `execution/` — the adapter boundary; wires in `@vigil/adapter-paper` (and
  later a live adapter) behind one execution interface.
- `outbox/` — durable dispatch: an approved intent is written once and
  retried as versioned attempts, never re-approved.
- `reconcile/` — periodic reconciliation against venue/chain truth.
- `health/` — heartbeats and the staleness checks that drive fail-closed
  behavior.

These are described, not created — `src/` stays empty until BOOT-06, when
`src/main.ts` arrives along with the first real module.

## Status

Empty scaffold. `src/main.ts` and the modules above are first filled under
planning ID BOOT-06.
