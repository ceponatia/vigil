---
name: vigil-testing
description: Decide whether a vigil change needs a test, choose the one owning layer, and report what CI actually verified. Use before creating, expanding, or substantially rewriting tests, and when reviewing whether coverage is sufficient. No new test is a valid outcome.
---

# Make a vigil testing decision

## Local execution boundary

Do not run application gates on this machine. This includes every form of
Vitest (`pnpm test*`, direct `vitest`, package-filtered Vitest, watch mode, and
`pnpm test:int`), application lint, typecheck, and build. Use CI through the
task's authorized delivery workflow.

Two narrow local checks remain allowed:

- `pnpm lint:docs`, for documentation-only changes, once that script exists in
  the repository.
- Dependency-free offline fixtures for skill-owned shell or Python helpers
  when they do not start vigil, a database, or an external service.

## Layers

| Layer | Location | Runs via |
| --- | --- | --- |
| Pure unit suites | `*.test.ts`, co-located with the code in `apps/*` and `packages/*` | Root Vitest project's `unit tests` job, `pnpm test` |
| Postgres-backed suites | `*.int.test.ts`, co-located with the code that needs a real database | `integration` job, `pnpm test:int` |
| Deterministic full replays | `tests/replay/` | `unit tests` unless a replay needs Postgres, then it is a `*.int.test.ts` and moves under `integration` |
| Fault-injection scenarios | `tests/fault-injection/` | Same split as replays: `unit tests` by default, `integration` only when a scenario needs Postgres |
| Synthetic fixtures | `tests/fixtures/` | Not a test layer; shared input data for the layers above |

Fixtures under `tests/fixtures/` never contain personal holdings, real
credentials, or real wallet addresses — a synthetic wallet, key, or account
identifier must be obviously fake, never a real one with digits redacted.

## Decide before writing

Answer these internally before writing:

1. The invariant, regression, contract, or failure mode the test would protect.
2. A realistic bad implementation that the test would catch.

Then search for existing coverage, static gates, and shared helpers. If
another gate already catches the defect, or no plausible defect is
identifiable, add no test. Read
[admission and ownership examples](references/admission-and-ownership.md) when
the decision is ambiguous, and especially for the domain-specific admission
rules — reason codes, money arithmetic, idempotency, state machines, and the
no-chasing guard — that this repository always expects a test for.

Choose the lowest layer that owns the claim. Test the full behavior matrix
once at that layer; higher layers prove only their connection to it. An
integration test must depend on real persistence, transactions, concurrency,
constraints, or route/database wiring. Pure deterministic logic — a policy
check, a strategy transition, a ledger calculation — stays in a pure suite.

Prefer strengthening a nearby test over adding a parallel suite. Prefer table-,
schema-, registry-, or property-derived assertions over copied case lists.
Before adding fixtures or builders, read
[existing helper lookup](references/existing-helpers.md).

## Rules that change the decision

- A bug fix needs the smallest regression test that fails for the observed
  bug, unless existing coverage already fails on the bad implementation.
- Degradation coverage asserts both the fallback and its reason code (fail
  closed on financial authority, degrade gracefully on research — assert
  which one applies).
- Registry coverage derives expectations from the registry (reason codes,
  operating modes, record families); do not hand-copy its members into the
  test.
- Research/thesis structure tests assert required fields and shape, not
  full-text snapshots or incidental wording — a `ResearchPacket` or
  `TradeProposal` is a structured contract, not prose to pin.
- A test exercising a venue, chain, or LLM/evidence integration uses a fake
  provider or adapter (`packages/adapter-paper`, a fake evidence/research
  gateway) rather than mocking calls at the fetch layer; do not restore
  provider credentials removed by test setup.
- Preserve literal pins only when the literal is the contract, such as a wire
  format, a persisted reason code string, a security allowlist, or a migration
  compatibility value.
- A behavior-preserving refactor does not create a testing obligation. Fix
  tests that break only because private arrangement changed.

When unrelated test debt is discovered, add it to the relevant existing GitHub
issue only if issue updates are within the current authorized scope. Otherwise
report it to the owner for routing. Never create a repository working
document for test debt.

## After a coding task

The `vigil-test-keeper` role (`.claude/agents/vigil-test-keeper.md`) applies
these rules to one finished change: it brings every test that owns the changed
or new code in line with the diff, edits tests only, and reports the CI
evidence. Its procedure is
[references/test-keeper.md](references/test-keeper.md); run it before an
implementation is reported complete.

## Finish with exact evidence

Name the test file changed, the claim it protects, and the CI job or script
that actually selects it. A green aggregate `verify` result means all
applicable jobs succeeded; it does not mean every repository suite ran — and
until the GitHub repository exists, no CI has run at all.

Read [CI evidence and uncovered suites](references/ci-evidence.md) before
claiming any coverage. Do not substitute a prohibited local run.

If no test was added, say why: existing coverage owns the invariant, another
gate catches the defect, or the change introduces no meaningful runtime
behavior.
