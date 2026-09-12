# @vigil/policy

Pure eligibility, risk, exposure, budget, and permission checks: the code
that decides whether a candidate is allowed to become an approved economic
intent. It answers yes/no and reason-code questions; it never itself acts on
the answer.

## What it owns

- Eligibility checks against a trade proposal (entry-zone validity, quote
  freshness, minimum notional).
- Risk and exposure limits (correlated exposure, drawdown, concentration).
- Operating-budget checks (LLM/RPC/data/hosting spend, separate from trading
  capital).
- The LIVE capability gate: the one place that can say a mode transition is
  permitted, driven by explicit configuration rather than an environment
  variable alone.

## What it must never do

- Perform IO of any kind (no network, no filesystem, no database reads —
  callers pass in the state this package evaluates).
- Call an LLM, or hold any opinion about one.
- Import `@vigil/market`, `@vigil/ledger`, `@vigil/strategies`,
  `@vigil/adapter-paper`, or `@vigil/db` — its only workspace dependency is
  `@vigil/contracts`.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

## Allowed workspace imports

- `@vigil/contracts`

## Planned modules

- `eligibility` — entry-zone, freshness, and minimum-notional checks.
- `risk-limits` — exposure, concentration, and drawdown limits.
- `budget` — operating-budget checks, separate from trading-capital checks.
- `capability-gate` — the explicit, non-env-var LIVE mode gate.

## Status

Empty scaffold. First filled under planning ID BOOT-06.
