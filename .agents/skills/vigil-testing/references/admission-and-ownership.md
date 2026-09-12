# Admission and ownership examples

Read this reference when it is unclear whether a test earns its maintenance
cost or which layer owns it.

## Other gates already own these claims

| Gate | Do not add a test merely to prove |
| --- | --- |
| TypeScript | Types, arity, nullability, exhaustive switches |
| Type-aware ESLint | Lint-shaped mistakes and unsafe flows |
| zod | That zod rejects a wrong shape; test vigil's fallback/reason code instead |
| `lint:cycles` (madge) | Circular imports |
| Layer-graph / package-boundary rules | Declared exports, forbidden sibling edges, an app importing a package it is not allowed to |
| Existing registry invariants | A new reason code or operating mode has a unique id, validates, and resolves references |
| jscpd | Copy-pasted scaffolding |

## Primary owner map

| Claim | Primary owner |
| --- | --- |
| Contract shape, reason-code vocabulary, timestamp family validation | `packages/contracts/src/**/*.test.ts` |
| Pure eligibility, risk, exposure, and budget checks | `packages/policy/src/**/*.test.ts` |
| Deterministic strategy transition, staged position plan | `packages/strategies/src/**/*.test.ts` |
| Ledger arithmetic, holdings-state transition, reconciliation math | `packages/ledger/src/**/*.test.ts` (pure) |
| Reservation atomicity, reconciliation against a real store | `packages/ledger/src/**/*.int.test.ts` |
| Exchange order-lifecycle transitions, simulated fills and costs | `packages/adapter-paper/src/**/*.test.ts` |
| Schema shape, migration, and persistence invariants | `packages/db/src/**/*.int.test.ts` |
| Deterministic full-history behavior | `tests/replay/**/*.test.ts` (or `*.int.test.ts` if it needs Postgres) |
| Scenario-level failure and recovery behavior | `tests/fault-injection/**/*.test.ts` (or `*.int.test.ts` if it needs Postgres) |
| Repository structure no compiler can discover | `scripts/*.test.ts` tripwire |

One invariant may have several seam checks without duplicating its matrix. A
pure policy suite can own every eligibility transition; a ledger integration
suite proves one representative reservation persists atomically; an
`apps/trading` suite proves an approved intent reaches the ledger and a
rejected one does not. Each layer states a different claim.

## Admission rules specific to this domain

These claims always need an owning test somewhere in the repository; do not
treat "no plausible defect" as available for them:

- **Every reason-code path** (`STALE_QUOTE`, `OUTSIDE_ENTRY_ZONE`,
  `MINIMUM_NOTIONAL`, `EXPOSURE_LIMIT`, the on-chain additions such as
  `SIMULATION_FAILED` or `ROUTE_UNAVAILABLE`, and any code added later) has a
  test that actually reaches it, not just a type that allows it.
- **Every money-arithmetic path** — fee, slippage, sizing, reservation,
  journal posting — has a test, and no test asserts a monetary value as a
  floating-point number.
- **Idempotency and deduplication**: the same proposal or job delivered twice
  yields at most one economic intent or tranche.
- **Reservation atomicity**: two strategies contending for the same funds
  produce only feasible aggregate spending, never an overcommit.
- **Reconciliation invariants**: venue holds and local reservations reconcile
  at a consistent watermark — no double-subtracting an acknowledged hold, no
  dropping a local commitment while a private feed catches up.
- **Every state-machine transition** in the exchange lifecycle (`PROPOSED` →
  … → `FILLED` / `CANCELED` / `REJECTED` / `EXPIRED`, including `UNKNOWN` and
  its reconciliation path) and the on-chain lifecycle (`PROPOSED` → … →
  `INCLUDED` → `FINALIZED`/`CONFIRMED`, including failed/reverted, replaced,
  dropped, and reorganized) has an owning test for that transition and for
  each terminal or limbo state.
- **The no-chasing entry guard**: a missed entry becomes `WAIT`/`MISSED`, never
  a rewritten `BUY`.
- A test exercising a venue, chain, or LLM/evidence integration uses a fake
  provider or adapter rather than mocking calls at the fetch layer — see
  [SKILL.md](../SKILL.md)'s Rules that change the decision.

## Strong candidates

Tests usually earn their place for an observed regression, an authority
boundary (who may hold a key, raise a limit, or approve an intent),
transaction/reservation rollback, concurrency, idempotency, persisted-format
compatibility, deterministic identity, a failure that must close safely (fail
closed on financial authority, degrade gracefully on research), promised
degradation, path containment, an external wire format, or an owner/operator-
visible behavior no other gate observes.

Tests usually do not earn their place for trivial accessors, object
construction, private helper call order, framework behavior, every enum
spelling, incidental formatting, snapshots of large generated text, or a
refactor that preserves behavior.

For an integration test, name the real-infrastructure fact the test requires.
If removing Postgres and replacing the store with an object would preserve the
claim, the claim belongs in a pure suite.
