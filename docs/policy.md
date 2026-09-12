# Policy

This page governs authority over money: who or what may propose an action, what may approve it, and what happens when things go wrong. [product.md](product.md) owns what the application is trying to accomplish; this page owns what it is allowed to do while trying. [capabilities.md](capabilities.md) owns whether a given venue or claim backing a policy check is actually verified.

## Authority model

LLMs generate research and proposals; deterministic, isolated components control money. Persuasive text never grants order, transfer, approval, signing, policy-change, or production-deployment permission. A research packet can be valid for analysis while ineligible for execution.

### Two spending firewalls

- **Trading capital** is only money the owner deliberately allocates. No bank credentials, bank-funding ability, borrowing, or autonomous capital replenishment. On-chain trading capital lives in dedicated wallets, never the owner's main wallet.
- **Operating expenses** — LLM providers, RPC/data services, hosting — draw from an independent budget. Per-call limits alone do not prevent a loop of many calls: estimated request cost is reserved before dispatch, concurrency/daily/monthly ceilings are enforced, actual usage is reconciled, and provider-side budget controls are used as a second layer where supported.

Owner ruling (2026-09-12): the owner supplies trading capital manually; the application never draws funds from a bank account or any other outside source.

### What no agent may ever do

No agent may raise its own risk limits, fund itself, rewrite live trading code, or deploy an unreviewed strategy. No LLM, research worker, or general-purpose agent ever holds a private key, a trade credential, or the ability to raise a limit.

## Operating modes

- **PAPER** — the default mode. Simulated execution against recorded or live-read market data; no real funds, no real signing.
- **SHADOW** — the full research-to-proposal pipeline runs against live data, but nothing executes; outcomes are logged as if it had, for comparison against what actually happens.
- **LIVE** — real capital moves. LIVE sits behind an explicit capability gate that requires all of the following at once:
  - a Verified capability record for the venue involved (see [capabilities.md](capabilities.md));
  - an owner-approved policy carrying actual numbers, not the unapproved examples below;
  - credentials isolated to the execution/signing boundary, never reachable from research or general-purpose code;
  - a passing fault-injection matrix for that venue's lifecycle; and
  - a demonstrated pause and rollback.

  An environment variable alone never enables LIVE mode.
- **PAUSED** — new risk is blocked; approved protective actions still run.

## Numerical controls

### Unapproved examples (discussion defaults, not policy)

The values below are carried over from planning discussion. They are not an approved policy, must not be deployed as configuration, and exist here only so they are not silently reinvented as if they were decided.

| Control                                | Discussion default                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| Strategy universe                      | Spot/unleveraged only.                                                               |
| New directional position               | Normally at most 5% of account/approved NAV.                                         |
| Single altcoin economic exposure       | At most 10%, including linked representations.                                       |
| Correlated sector exposure             | At most 25%.                                                                         |
| Planned adverse loss per trade         | At most 0.25% of NAV, with cost/slippage allowance.                                  |
| Aggregate stop-based open risk         | At most 1% of NAV.                                                                   |
| Daily marked-to-market loss            | Pause new risk at 2%; preserve approved protective actions.                          |
| Cash-flow-adjusted high-water drawdown | Pause and require review at 8%.                                                      |
| Locked/yield allocation                | At most 20% total and 10% per protocol/strategy exposure group.                      |
| Liquid reserve                         | Originally 20% in USD; reserve asset/location needs revision for on-chain execution. |
| Operating spend                        | Hard dollar ceiling, amount not chosen.                                              |

Per-wallet, per-chain, per-contract, per-transaction, gas/priority-fee, and residual-inventory limits are added once a venue is actually selected. They are not invented ahead of that selection.

### Position sizing rule

A sized trade is the **minimum** of: funds actually available, the applicable exposure limit, executable liquidity at the venue, and the planned adverse-loss budget. Round down to the venue's supported precision. If the result falls below the venue's minimum, or is too small to be economically meaningful, skip the trade — never round up beyond its risk budget to make it tradable.

## Exchange credentials

Use the minimum supported permission set: separate read/accounting, trade, and Earn-style credentials where the venue offers them. Withdrawal and funding authority are excluded from every exchange credential vigil holds. An application-level endpoint allowlist applies even when a provider's permission groups are broader than the capability actually needed.

Only the execution/signing boundary holds a trade credential. Secrets live in a secret manager or host secret facility — never in source, committed `.env` files, application tables, prompts, exception reports, or logs. Outbound-IP restriction is used where supported. The application records credential references, permission audits, rotation metadata, and last-verification time; it never exposes a plaintext secret in the UI. Rotating a credential requires a controlled pause and reconciliation, not a swap while orders are unresolved.

## On-chain signer requirements

No LLM, research worker, or general-purpose agent gets a wallet seed, a private key, or unrestricted signing access. A dedicated funded wallet and an isolated signing service, administered outside the trading agent's authority, are the only path to a signature.

The signer validates the full proposed transaction before signing: chain, token identities, exact spend, recipient, route, approved contracts/methods, minimum output, deadlines, allowances, nested calls, and fee ceilings. An allowlisted router address is not sufficient on its own if its embedded instructions can move value elsewhere. Arbitrary transfers, unlimited approvals by default, borrowing, unapproved bridges, changes to wallet authority, and signing payloads that cannot be adequately decoded or constrained are all rejected. Simulation is required where the chain supports it, but a passing simulation is not a guarantee of safety or inclusion.

## LLM and retrieval security

Route LLM calls through a provider-neutral gateway with approved models/providers/versions, schema validation, prompt versions, per-call caps, caching, concurrency limits, and pre-evaluated fallbacks. A model upgrade is a candidate deployment, not a silent production behavior change.

Structured output constrains shape, not truth: every response is validated for asset identity, enums, evidence references, timestamps, missing inputs, and policy eligibility after the call returns. Webpages, news, social posts, token metadata, and repository text are all untrusted evidence — an embedded instruction to disable a control, reveal a secret, or use a different wallet has no route to authority. Research and numeric tools are the only tools an LLM call may reach; there is no arbitrary executor payload and no production shell access from that path.

A critic role may challenge a consequential proposal, and a post-trade reviewer may classify an outcome, but nothing runs an expensive multi-agent debate on every tick, and correlated agreement between multiple models is never treated as independent market evidence.

## Emergency controls

Four distinct commands exist, and none of them is interchangeable with another:

- **Pause new entries** — stops new risk-taking; does not touch existing positions or protection.
- **Cancel nonprotective actions where possible** — cancels what the venue allows canceling; does not guarantee cancellation of something already broadcast or acknowledged.
- **Reduce liquid exposure** — moves toward cash/settlement reserve for what is actually liquid; does not unlock staked, unbonding, or otherwise locked funds.
- **Cancel everything where supported** — the broadest available action; still bounded by what the venue or chain actually supports, and it is never a liquidation facility.

None of the four guarantees immediate disposal of locked yield, cancellation of an already-included on-chain transaction, or an exchange-native stop with no on-chain equivalent. The UI never labels exposure "safe" while any of it remains unresolved, unprotected, or on a venue whose protection primitive is unverified.

## Reason codes

The table below is vigil's own reason-code vocabulary — not an exchange, chain, or provider error code. It is extended only through this document.

| Code                       | Meaning                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| STALE_QUOTE                | The market or route quote backing the decision is older than its freshness threshold.                 |
| OUTSIDE_ENTRY_ZONE         | The current executable price has moved outside the proposal's approved entry zone.                    |
| MINIMUM_NOTIONAL           | The sized trade falls below the venue's or policy's minimum tradable size.                            |
| INSUFFICIENT_NET_EDGE      | Expected advantage after all fees, spread, and costs does not clear the required threshold.           |
| EXPOSURE_LIMIT             | The action would breach a single-asset, sector, or portfolio exposure cap.                            |
| YIELD_LOCKED               | The targeted funds are staked, unbonding, or otherwise locked and unavailable to reserve.             |
| RESEARCH_EXPIRED           | The evidence or research packet backing the proposal has passed its validity window.                  |
| THESIS_INVALIDATED         | A tracked invalidation condition for the position's thesis has been met.                              |
| ACCOUNT_UNRECONCILED       | Venue or wallet balances have not been reconciled against the ledger since the last known-good state. |
| PROTECTION_UNAVAILABLE     | The required stop, trim, or exit mechanism is not currently available for the position.               |
| OPERATING_BUDGET_EXHAUSTED | The operating-expense budget for LLM, data, or RPC spend is depleted for the current period.          |
| WRONG_CHAIN                | The resolved asset or route does not match the intent's declared chain identity.                      |
| UNAPPROVED_ASSET           | The resolved contract/mint is not on the approved asset list for its declared identity.               |
| UNAPPROVED_RECIPIENT       | The transaction's recipient address is not an approved destination.                                   |
| UNAPPROVED_CONTRACT        | The transaction targets a contract or method outside the approved allowlist.                          |
| ALLOWANCE_POLICY_VIOLATION | The requested token allowance exceeds policy — unlimited, or granted to the wrong spender.            |
| SIMULATION_FAILED          | Pre-broadcast simulation did not validate the transaction's expected effects.                         |
| INSUFFICIENT_GAS_RESERVE   | Dispatch would breach the bounded gas/priority-fee reserve.                                           |
| TRANSACTION_UNRESOLVED     | A prior transaction's outcome is still unknown and blocks new economic action on the same funds.      |
| ROUTE_UNAVAILABLE          | No approved swap/execution route currently satisfies the request.                                     |

## Operating-expense budget rules

- The estimated cost of a request is reserved before it is dispatched, not accounted for after the fact.
- Concurrency, daily, and monthly ceilings apply on top of per-call limits, because per-call limits alone do not stop a loop of many cheap calls.
- Exhausting the operating budget stops discretionary research. It never stops deterministic risk management — pausing new entries, protective exits, and reconciliation keep running regardless of operating spend.
- There is no automatic credit replenishment. A depleted budget stays depleted until the owner tops it up.
- No paid infrastructure — hosting, data, or RPC — is provisioned without the owner's budget approval.
