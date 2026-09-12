# 0002. Authority boundaries and process topology

## Status

Accepted. This ADR restates owner requirements and their clarifications; it is not a proposal awaiting confirmation.

## Context

The project separates LLM-driven research and proposal generation from deterministic financial authority: an LLM may generate a thesis or a proposal, but nothing about that generation gives it the ability to move money. The owner also supplies trading capital manually — the application never touches bank funding — and keeps trading capital and the operating budget (LLM calls, RPC, data, hosting) as separate firewalls, so that exhausting one never silently draws on the other. These are requirements, not implementation details, and they force a specific process topology rather than leaving it open.

## Decision

Research and proposal components never hold a trade credential, a signing key, or the ability to raise a limit. Exactly one process holds effective write authority per financial authority domain at any moment. The signer, once built, is an isolated process with its own secrets, administered outside the trading agent, applying deterministic policy checks to the actual transaction rather than trusting what requested it.

`PAPER` is the default operating mode. `LIVE` sits behind an explicit capability gate that no environment variable can open on its own — setting `VIGIL_MODE=LIVE` is necessary but never sufficient. `SHADOW` and `PAUSED` are the other modes.

The pilot collapses this topology to two processes plus a database: `apps/trading` (the deterministic runtime and its paper adapter) and `apps/control` (the dashboard and typed control API), against Postgres. `apps/research`, `apps/signer`, and `apps/evaluation` are added later, each behind its own gate, when the capability it requires is actually needed. Adapters that hold venue credentials are packages, `packages/adapter-<venue>`, and only `apps/trading` may import one — `apps/control` cannot, by construction, reach a venue credential through its own code.

## Consequences

The layer graph and process topology in [architecture.md](../architecture.md) exist to enforce this decision, not the reverse — the ESLint zone rules, the `apps/trading`-only adapter import rule, and the planned `lint:package-boundaries` script are how "research never holds authority" becomes a fact a reviewer can check rather than a convention that can quietly erode. CI runs with no secret available to it, on the same logic: if a job needed a venue, RPC, or LLM credential to pass, that credential would have to exist somewhere CI can reach it, which is a bigger hole than the job is worth.

The capability ladder — `PAPER` now, `LIVE` only once a signer, a policy set, and an approved venue all exist and are wired to a real gate — means every planned process (`apps/research`, `apps/signer`, `apps/evaluation`) is scoped in [architecture.md](../architecture.md#not-built) as not built rather than partially built, until its own gate is met. A later ADR is required to change which process may hold which authority; this one is not amended for that, it is superseded.
