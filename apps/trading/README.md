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
  later a live adapter) behind one execution interface. **Built.** See
  "The execution domain" below.
- `outbox/` — durable dispatch: an approved intent is written once and
  retried as versioned attempts, never re-approved.
- `reconcile/` — periodic reconciliation against venue/chain truth.
- `health/` — heartbeats and the staleness checks that drive fail-closed
  behavior.

Every directory above but `health/` and `execution/` is described, not
created — `market/`, `strategy/`, `allocator/`, `outbox/`, and `reconcile/`
arrive with the rest of BOOT-06.

## The execution domain

`src/execution/` carries one approved intent from a policy decision through a
simulated fill:

```text
authorize.ts        evaluateProposal, then the durable ApprovedEconomicIntent
dispatch.ts         reserve -> attempt + outbox -> REVALIDATE -> submit
revalidate.ts       the fresh-quote / net-edge gate every dispatch runs
settle.ts           poll, cancel, reconcile; confirmed economics and the journal
recover.ts          the read a restart owes an unresolved dispatch
venue.ts            the injected venue cost model, with no default for any field
venue-economics.ts  the exact arithmetic and the policy cost translation
```

Two properties are worth knowing before reading any of it.

**Everything is injected.** An `ExecutionRuntime` carries the database, the
exchange, the venue cost model, the limit set, and the writer identity; the
domain reads no environment variable and no clock. That is why `main.ts` does
not start it: a venue fee rate, a slippage cap, and a flat execution cost are
owner-approved numbers, and this build has none to read. Wiring the domain
into the process needs those configuration variables to exist first.

**The price handed to `@vigil/policy` is the venue's execution price**, not
the ask, so the spread and the slippage cap are both `embedded` in the cost
model policy consumes and the proportional fee lands on the notional the
venue actually charges it on. `venue-economics.ts` states the full table and
why the other wiring under-bounds the fee.

Two things this domain deliberately does not do: it authorizes entry actions
only (an exit needs a position basis and realized-P&L accounting that does
not exist yet), and it builds no cancellation retry, scheduler, or incident —
what a chase driver needs from here is that an unresolved cancellation is
durably visible as `CANCEL_PENDING`, which it is.

## Status

`src/main.ts`, `health/` and `execution/` exist: config parsing,
a database connection, structured pino logging, and a heartbeat loop that
writes this instance's operating mode and last-quote age on an interval —
what `apps/control`'s Runtime health section reads. `loadTradingConfig`
refuses to start under SHADOW or LIVE with a diagnostic rather than
starting a runtime with no market/strategy/execution pipeline behind
either mode yet; PAPER and PAUSED are the only modes this build enters.
Every other module above remains planned.
