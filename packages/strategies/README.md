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

## Modules

- `candidate` — `candidateSchema`/`Candidate`: a frozen, schema-validated
  candidate record (entry zone, expiry, invalidation price and conditions,
  horizon, staged position plan, benchmark reference), and
  `generateCandidate`, the deterministic numeric rule that proposes one
  from a quote: a bounded pullback band below the current ask, per a
  documented `StrategyConfig` (`DEFAULT_STRATEGY_CONFIG`). Three distinct
  outcomes: a `"candidate"`; a policy-vocabulary `"no-candidate"` refusal
  (a `REASON_CODES` member such as `STALE_QUOTE`, fail closed on bad
  market data); or `"no-signal"` (`StrategyNoSignalCode`, e.g.
  `PRICE_LEVEL_BELOW_RULE_RANGE`) when the ask is schema-legal but too low
  for the rule's configured offsets — never a thrown error. Ids
  (`candidateId`, `idempotencyKey`, `correlationId`) are derived
  deterministically from the strategy identity, instrument, and the
  quote's own acquisition time, so the same event delivered twice
  persists once.
- `position-plan` — `buildPositionPlan`: splits a candidate's
  `totalQuantity` into bounded, idempotent tranches whose quantities sum
  exactly to the total (bigint arithmetic, no remainder dropped) and whose
  trigger prices always fall inside the entry zone.
- `no-chasing` — `evaluateEntry`: classifies the current executable price
  against a candidate's already-approved zone —
  `ENTRY_ELIGIBLE | WAIT | MISSED | BLOCKED` — without ever deriving a new
  zone from today's price. A missed entry stays `WAIT`/`MISSED`, never a
  rewritten `BUY` (`docs/product.md` "Action vocabulary"). A stale or
  corrupt quote blocks the check closed (`BLOCKED`, `STALE_QUOTE`) via
  `@vigil/market`'s `evaluateQuoteFreshness`, the same gate `candidate`
  uses on generation.
- `scaled-decimal` — `toScaled`/`fromScaled`/`compareDecimal`/
  `addDecimal`/`subtractDecimal`: a minimal bigint-on-scaled-integers
  helper for this package's own entry-zone and tranche arithmetic, kept
  independent of `@vigil/ledger`'s `base-units.ts` because this package
  cannot import `@vigil/ledger` (see "Allowed workspace imports" above).
  Issue #20 owns unifying the two seams later.

Sizing policy, cost/edge checks, and turning `ENTRY_ELIGIBLE` into an
actual `BUY` intent are not this package's job — they read a `Candidate`
and an `EntryEvaluation` this package produces, but decide nothing here.
