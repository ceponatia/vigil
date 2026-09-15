# @vigil/policy

Pure eligibility, risk, exposure, budget, and permission checks: the code
that decides whether a candidate is allowed to become an approved economic
intent. It answers yes/no and reason-code questions; it never itself acts on
the answer.

## What it owns

- Eligibility checks against a trade proposal (entry-zone validity, quote
  freshness, account reconciliation, net edge after costs, exposure caps).
- The position sizing rule, and the `MINIMUM_NOTIONAL` skip that refuses a
  size too small to trade rather than rounding it up.
- Risk and exposure limits (correlated exposure, drawdown, concentration).
- Operating-budget checks (LLM/RPC/data/hosting spend, separate from trading
  capital).
- The LIVE capability gate: the one place that can say a mode transition is
  permitted, driven by explicit configuration rather than an environment
  variable alone.

## What it must never do

- Perform IO of any kind (no network, no filesystem, no database reads —
  callers pass in the state this package evaluates).
- Read a clock. `now` is a parameter on every check that needs one.
- Call an LLM, or hold any opinion about one.
- Import `@vigil/market`, `@vigil/ledger`, `@vigil/strategies`,
  `@vigil/adapter-paper`, or `@vigil/db` — its only workspace dependency is
  `@vigil/contracts`.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).
- Hardcode, default, or otherwise approve an owner limit. `docs/policy.md`'s
  numerical table is unapproved discussion defaults; every limit here is
  injected configuration.

## Allowed workspace imports

- `@vigil/contracts`

## Modules

Built:

- `config` — the injected limit set and the guard that refuses a malformed
  one. No defaults for any limit; unknown keys are refused, not ignored.
- `diagnostics` — `POLICY_EMITTED_REASON_CODES` (the six `docs/policy.md`
  codes this package raises, out of the full twenty) and
  `POLICY_DIAGNOSTIC_CODES` (this package's local vocabulary for an input
  that makes the question unanswerable). The two are kept apart in type and
  name so a caller cannot record an input bug as a policy decision.
- `eligibility` — the five checks: `ACCOUNT_UNRECONCILED`, `STALE_QUOTE`,
  `OUTSIDE_ENTRY_ZONE`, `EXPOSURE_LIMIT`, `INSUFFICIENT_NET_EDGE`.
- `sizing` — the position sizing rule: the minimum of funds available,
  exposure headroom, executable liquidity, and the adverse-loss budget,
  rounded down to venue precision, with `MINIMUM_NOTIONAL` below the
  minimum. Reports which bound was binding.
- `evaluate` — `evaluateProposal`, the composed gate that runs all of the
  above in one fail-closed order. The individual checks stay exported, but
  this is the path `apps/trading` is meant to take.
- `scaled-decimal` — private bigint-on-scaled-integers arithmetic. Not
  exported; issue #20 owns unifying it with the copies in `@vigil/ledger`
  and `@vigil/strategies`.

Planned, not built:

- `risk-limits` — drawdown and aggregate open-risk limits beyond the
  per-proposal exposure caps `eligibility` already checks.
- `budget` — operating-budget checks, separate from trading-capital checks
  (`OPERATING_BUDGET_EXHAUSTED`).
- `capability-gate` — the explicit, non-env-var LIVE mode gate.

## Boundary convention

Every threshold is inclusive of its own boundary: a quote exactly at
`maxQuoteAgeMs` is fresh, a price exactly at `entryZone.max` is inside the
zone, net edge exactly at `minimumNetEdgeQuote` clears it. Exposure is the
apparent exception and is not one — a cap bounds *resulting* exposure, so a
cap already met leaves zero headroom and refuses.
