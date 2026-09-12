# vigil

vigil is an autonomous crypto research, trading, and yield-allocation application for one owner's deliberately allocated capital. It researches continuously across approved exchanges and dedicated on-chain wallets, looking for arbitrage and price-dislocation opportunities, directional entries and exits, and longer-term staking, lending, and liquidity-provision yield — chosen by total execution economics and risk, not by a single preferred venue.

Large language models generate research, evidence, and trade proposals; they never hold a trade credential, a signer key, or the ability to raise a risk limit. Deterministic, isolated components — policy checks, the portfolio and risk allocator, the execution and signing boundary — are the only path from a proposal to money moving. The owner supplies trading capital manually and separately from the application's own operating budget; the application never draws on a bank account.

## Status

- Bootstrap: no vertical slice runs end to end yet.
- PAPER is the only operating mode that exists. SHADOW and LIVE are designed but not implemented, and LIVE stays behind an explicit capability gate.
- No live exchange venue, on-chain signer, LLM provider, or hosting environment is connected. Every venue and tool in [docs/capabilities.md](docs/capabilities.md) is Unverified.
- Nothing in this repository is verified profitable. Example risk and cost figures carried over from planning discussions are unapproved and appear only where a document explicitly labels them as examples.

## Safety posture

1. LLMs research and propose; deterministic, isolated components control money. No LLM, research worker, or general-purpose agent ever holds a trade credential, a signer key, or the ability to raise a limit.
2. The owner manually supplies trading capital; the application never touches bank funding. Trading capital and the operating budget (LLM, RPC, data, hosting spend) are separate firewalls.
3. PAPER is the default operating mode. LIVE sits behind an explicit capability gate and is never enabled by an environment variable alone. SHADOW and PAUSED are the other modes.
4. Financial authority fails closed: new risk blocks on stale, corrupt, or unreconciled state. Research degrades gracefully instead. Protective actions are never blocked.
5. Money is never floating point: decimal strings on the wire, exact integer base units or a decimal type internally.
6. An approved economic intent is immutable and consumable once; retries are versioned attempts on the same intent, never a repeat authorization.
7. No chasing: every entry has a zone, an expiry, and an invalidation condition; a missed entry becomes WAIT/MISSED, never a rewritten BUY.
8. Every policy-eligible candidate is journaled before its outcome is known — executed, rejected, expired, missed, or avoided.
9. Venues are approved exchanges and dedicated on-chain wallets, chosen by total execution economics and risk; nothing venue-specific — chain, stablecoin, router, signer provider, trading framework, or risk percentage — is selected yet.
10. Personal holdings, secrets, and private planning material never enter fixtures, logs, docs, issues, or commits.

## Getting started

Local setup, environment variables, database bring-up, and the commands for running the app and its tests live in [docs/getting-started.md](docs/getting-started.md).

## Layout

The directory layout, module boundaries, and data flow are documented in [docs/architecture.md](docs/architecture.md).

## Working in this repository

Agent roles, authority boundaries, the CI-only gate policy, and the Vigil Development board are described in [AGENTS.md](AGENTS.md).

## Documentation

The full documentation set, its reading order, and the rules for maintaining it live in [docs/README.md](docs/README.md).
