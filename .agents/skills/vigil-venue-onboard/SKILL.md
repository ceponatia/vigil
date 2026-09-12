---
name: vigil-venue-onboard
description: Onboard or revise a vigil venue — an exchange, chain, protocol, router, or signer provider — by coordinating capability evidence, the docs/capabilities.md row, and staged authority. Use when adding a venue, changing its API version or supported network, or changing a claimed capability such as a protection primitive, fee tier, or signer policy control.
---

# Onboard a vigil venue

Coordinate one evidence-backed venue change from provider identity through the
row it is allowed to occupy in `docs/capabilities.md`. A documented feature, an
account- or chain-observed behavior, and an enabled trading stage are separate
claims; prove and place each one at its owning seam.

## Establish the evidence boundary

Before touching any row, record the venue kind (exchange, chain, protocol,
router, or signer provider), its exact identity (exchange + API version and
account/pair, or chain id + protocol/router address), the asset(s) involved by
chain plus contract/mint or native denomination (never a ticker alone) plus the
withdrawal network, the vigil trading stage the change targets, and whether
read-only credentials or paid/on-chain probes are authorized for this task.

Read [evidence states](references/evidence.md), then the applicable route:

- [Exchanges](references/exchanges.md)
- [On-chain: chains, protocols, routers, signers](references/on-chain.md)

Use primary provider documentation to identify candidate fields and
constraints, never a marketing page, blog post, or the private design handoff.
Label what the evidence actually proves. A website feature is never proof of
API availability. An undocumented endpoint is never used, and a logged-in
browser session is never automated to work around an unsupported integration.

## Classify, never assume

Every capability row in `docs/capabilities.md` carries exactly one of three
states:

- **Verified** — primary documentation plus an account- or chain-observed
  behavior, both cited, recorded with the observation date as an
  owner-visible evidence entry (see [evidence states](references/evidence.md)
  for where "owner-visible" must live).
- **Unsupported** — verified absent: the provider's own documentation
  explicitly excludes it, or an observed call/request is explicitly rejected
  or refused for that reason.
- **Unverified** — the default. Anything not carrying a completed capability
  record stays Unverified, including anything copied from the design handoff,
  a forum post, or a prior model's confident-sounding claim.

Only a completed [capability record](templates/capability-record.md) moves a
row out of Unverified. Do not upgrade a row on the strength of documentation
alone, an unauthenticated public endpoint, or a claim this skill did not
itself observe.

## Onboarding never touches money or authority

Regardless of stage, onboarding work under this skill never:

- places a trade or submits an order, live or on a live-connected sandbox;
- moves funds, initiates a withdrawal, or funds a wallet;
- requests, generates, stores, or transmits a seed phrase or private key —
  read-only credentials, when needed for observation, are supplied by the
  owner for that specific purpose and are never committed, logged, or stored
  in the repository;
- enables LIVE mode, or treats a capability record as authorization to do so.

A venue enters at **research-only**, advances to **read-only market data**,
then to **paper execution against recorded data**, and only then, behind its
own separate gate, to a **live canary**. Each capability record states which
of these stages its evidence actually supports; evidence for one stage is
never stretched to imply the next.

## Place each change once

- `docs/capabilities.md` owns the durable Verified/Unsupported/Unverified row
  per venue and capability. It is the only place a capability's status is
  asserted as project fact.
- `packages/contracts` owns asset and venue identity shapes (chain plus
  contract/mint or native denomination, withdrawal network, timestamp
  family) — never a venue-specific quirk.
- `packages/market` owns venue-neutral asset/instrument/pool identity and
  recorded market/quote snapshots used to validate a capability claim.
- `packages/db` owns the durable venue and evidence-reference rows (credential
  *references* and permission/rotation metadata only — never plaintext
  secrets, and never a seed or private key).
- `packages/adapter-<venue>` (convention: one package per live venue) owns the
  provider-specific wire mechanics that a capability record proves exist;
  only `apps/trading` imports it. `packages/adapter-paper` remains the only
  adapter that may run before a venue clears its own live-canary gate.
- `packages/policy` owns venue-neutral eligibility, exposure, and permission
  checks; a capability record can inform a policy limit, but policy code
  never hard-codes a single venue's undocumented behavior.
- `docs/decisions/` owns the ADR once a venue, chain, stablecoin, router, or
  signer choice is actually settled — not proposed, not "likely."

## Prove the delivered evidence

Use the fixed delegated-implementation roles (`vigil-builder`,
`vigil-escalation`, `vigil-reviewer`, `vigil-test-keeper`) for any code that
consumes a capability record; this skill governs evidence-gathering and
classification, not code review authority. Execution, ledger, policy, signer,
and reconciliation code stay risk areas that start on escalation.

Never run local application gates (`pnpm test*`, `pnpm lint*`,
`pnpm typecheck`, `pnpm build`, any Vitest form) to validate a venue claim.
GitHub Actions CI is the gate for code; a dependency-free offline fixture for
a skill/hook helper may still run locally. A capability record's evidence
comes from provider documentation and directly observed account/chain
behavior, not from CI passing.

Report, per capability: the exact classification and the two citations behind
it (documentation and observation), the stage the evidence actually supports,
the evidence file path under `eval-output/venues/<venue>/`, the
`docs/capabilities.md` row touched, and any ADR opened. Mark anything you
could not observe as Unverified rather than inferring it from documentation,
a sibling venue, or the design handoff.
