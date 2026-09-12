# 0001. TypeScript-first runtime

## Status

Accepted — owner ruling (2026-09-12). The original proposal for this project was Python for trading and analysis with a TypeScript dashboard; this ADR records the reversal of that split, confirmed by the owner.

## Context

The owner asked for the most current environment and tools available and otherwise left the runtime language open. Separately, the decisive requirements for this codebase — exact decimal arithmetic, durable idempotent intents, a durable outbox, a policy-checked signer boundary, a Postgres ledger, and deterministic replay — are engineering-discipline requirements. None of them are specific to a trading-framework ecosystem, and none of them favor one language's numeric or concurrency model over another's on their own.

Two further facts weigh on the choice. First, the project's scope is on-chain-first: the primary execution surface is wallet-signed transactions against a chain, not necessarily exchange order books, which removes most of the pull toward Python's exchange-trading-framework ecosystem. Second, the owner's existing agent-driven development workflow is already a pnpm/TypeScript monorepo with its own skills, hooks, and CI conventions — a second language would mean a second toolchain, a second CI shape, and a second set of import-boundary rules to keep in sync with the first.

## Decision

Build the pilot on one TypeScript runtime: Node 24, pnpm, Drizzle ORM against Postgres, zod for schema validation, Vitest for tests, and a Next.js dashboard. Money is represented as decimal strings on the wire and exact integer base units or a decimal type internally, never floating-point. When a chain is selected, its client library is added directly into this runtime — viem for an EVM chain, `@solana/kit` for Solana — rather than adopted as a separate service. NautilusTrader, Hummingbot, and Freqtrade are not adopted as the core trading runtime; none of them is built around a wallet-signed on-chain lifecycle, and adopting one would mean bending this project's execution model to an exchange-shaped framework instead of the reverse.

## Consequences

One toolchain, one CI pipeline, and one lint-enforced import-boundary system serve the entire repository — there is no seam where a second language's package manager, test runner, or lint configuration needs separate maintenance.

The evaluation/ML worker is a reserved Python (`uv`) seam, not created now: it exchanges Parquet files and JSON Schema generated from the zod contracts, and it is created only when offline modeling needs exceed what the Node ecosystem reasonably supports. Until then, evaluation logic that fits in TypeScript stays in TypeScript.

This decision is revisited if any of the following becomes true: a venue-specific trading framework demonstrably reduces engineering work without imposing exchange-shaped assumptions on the on-chain execution lifecycle; the evaluation worker's ML needs grow past what the reserved Python seam comfortably covers; or the owner states a different preference. None of these has occurred yet.

## Alternatives considered

- **Python-first**, matching the original proposal. Pro: direct access to the exchange-trading-framework and quantitative-Python ecosystem (NautilusTrader, pandas, and similar). Con: a second toolchain alongside the owner's existing TypeScript agent workflow, and an ecosystem shaped around exchange order books rather than the wallet-signed on-chain lifecycle this project now centers on.
- **Polyglot with a Rust core** for the ledger and execution domain. Pro: the strongest available guarantees for exact arithmetic and concurrency-safe state. Con: a third toolchain and a compiled-artifact release process, disproportionate to a pilot of this size; TypeScript with zod and a decimal type meets the same correctness requirements without it.
