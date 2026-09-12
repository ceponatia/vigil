# Capabilities

This page tracks what vigil actually knows how to do, venue by venue and claim by claim, separately from what [product.md](product.md) wants to do and what [policy.md](policy.md) would allow once it is possible. A row here is a status, not an aspiration.

Every row carries exactly one of three statuses:

- **Verified** — primary provider documentation and an account- or chain-observed result agree, both cited with an observation date.
- **Unsupported** — verified absent: the provider's own documentation explicitly excludes the capability, or an observed call is explicitly refused for that reason.
- **Unverified** — the default for everything else, including anything sourced only from planning discussion, a blog post, or a confident-sounding restatement of either.

Only a completed `vigil-venue-onboard` capability record moves a row out of Unverified. A row never gets upgraded on documentation alone, an unauthenticated public endpoint, or a claim nobody has actually tested against the account, wallet, or chain in question. Every row in this document currently starts, and currently remains, **Unverified**.

## Venues and tools

| Venue or tool                         | Discussed role                                                     | Status     | What must be verified                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kraken                                | USD on-ramp/off-ramp and optional spot execution.                  | Unverified | Current fee schedule and account tier, stablecoin withdrawal network support, funding/withdrawal holds, cancel-all-after behavior, Earn API access. |
| Coinbase on-ramp                      | Alternative USD-to-stablecoin funding path.                        | Unverified | Actual conversion terms, funding-method costs, withdrawal charges, and account/region eligibility.                                                  |
| Base                                  | Candidate first EVM chain for swaps and later approved yield.      | Unverified | Relevant asset support, actual quote economics, and wallet-control mechanics.                                                                       |
| Solana                                | Candidate chain for swap-focused execution.                        | Unverified | Current Jupiter integration, transaction lifecycle, and total cost.                                                                                 |
| Arbitrum                              | Candidate later EVM venue when liquidity/opportunities justify it. | Unverified | Whether fragmenting inventory there is economically justified versus the first chain.                                                               |
| Cosmos/Injective-related venues       | Candidate venues aligned with the research-seed interests.         | Unverified | Whether EVM/Solana routing or stablecoin support extends to these networks at all.                                                                  |
| 0x Swap API                           | Candidate EVM routing integration.                                 | Unverified | Approval targets, quote fields, transaction content, fees, and current API behavior.                                                                |
| Jupiter                               | Candidate Solana route source / execution integration.             | Unverified | Current Swap API version, managed-vs-self-managed fee structure, and maintenance status of prior integration paths.                                 |
| Uniswap                               | Candidate direct protocol/pool execution and quote reference.      | Unverified | Pool-specific fee tier, liquidity, and route structure per opportunity.                                                                             |
| Approved lending/staking/LP protocols | Candidate direct yield strategies on a dedicated wallet.           | Unverified | Protocol API access, lock/exit mechanics, and net-of-cost advantage per protocol.                                                                   |
| Policy-controlled signer providers    | Candidate isolated signer for on-chain transactions.               | Unverified | Whether the provider enforces nested-call, recipient, asset, and spend constraints, and whether the application can alter the policy.               |

## Claims requiring verification

Figures below carried over from planning discussion are phrased as *reported* or *hypothetical* — they are not observed quotes, and none of them is configuration.

| Claim                                                                                                                                                  | Why it matters                                                                                       | Status     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------- |
| Kraken spot fees reported as 0.40% maker / 0.80% taker, with stablecoin/FX reported at 0.20%.                                                          | Drives the venue cost comparison; must not be hard-coded as fact.                                    | Unverified |
| Coinbase USD-USDC conversion reported as 1:1 with no conversion fee.                                                                                   | Funding, withdrawal, and account-specific costs may still apply.                                     | Unverified |
| Kraken direct USDC withdrawal reported as supported on Base, Arbitrum, and Solana.                                                                     | Network/account availability, token identity, fee, and minimum must be confirmed.                    | Unverified |
| Kraken ACH/Plaid funding reported to carry a seven-day withdrawal hold.                                                                                | Affects treasury timing and whether funds are usable on the assumed schedule.                        | Unverified |
| Jupiter Swap V2 reported to separate a managed path from a router path; Ultra reported as no longer actively maintained.                               | Version-sensitive; determines which integration contract to build against.                           | Unverified |
| 0x routing, allowance targets, and transaction semantics as discussed.                                                                                 | Determines whether the returned transaction can be safely policy-validated.                          | Unverified |
| Policy-controlled wallet/signing products reported to support nested-call and spend constraints.                                                       | Core to the signer boundary; must confirm the policy cannot be altered by the application itself.    | Unverified |
| NautilusTrader's Kraken adapter reported to have OCO/bracket and instrument-status limitations.                                                        | Affects whether the framework can be trusted for protective orders.                                  | Unverified |
| Kraken Earn and Kraken DeFi Earn reported as distinct products with different API reachability.                                                        | A branded product may not be reachable through the assumed endpoint.                                 | Unverified |
| Same-chain atomic execution reported as achievable for compatible routes.                                                                              | Must not be assumed universal across every route or protocol pairing.                                | Unverified |
| Native-versus-bridged stablecoin support and issuer migration status.                                                                                  | Token identity and support can change; affects custody and settlement choice.                        | Unverified |
| Circle reported to be discontinuing USDC and CCTP v1 support on Noble, with specific cutoff dates cited.                                               | Affects Cosmos settlement and bridge routes; the dates are unconfirmed against any primary source.   | Unverified |
| Current jurisdiction/account/protocol eligibility for the owner's actual accounts.                                                                     | Capability discovery must reflect actual permitted usage, not general availability.                  | Unverified |
| Cost-routing example: a roughly $100 buy and sell reported at a 0.80% taker fee versus a hypothetical 0.10% swap fee plus $0.02 network cost per side. | Illustrates why total-cost routing matters; the figures are a worked example, not an observed quote. | Unverified |
| Reported per-cycle advantage of approximately $1.36 under those hypothetical assumptions, before spread/price impact and on/off-ramp costs.            | Explains a possible advantage, not a profitability forecast.                                         | Unverified |
| Hypothetical $30/month operating bill against $1,000 of capital, described as a 3% monthly expense hurdle.                                             | Illustrates why fixed operating costs matter for a small pilot; not an approved budget.              | Unverified |
| Hypothetical 6% annual yield on $100 described as $6/year before costs and losses.                                                                     | Illustrates gross-versus-net yield reasoning; not a yield estimate for any specific protocol.        | Unverified |

## Trading frameworks considered

| Candidate           | Useful for                                                                                             | Not established                                                                                      | Status                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Hummingbot / Condor | Closest architectural match for LLM reasoning connected to deterministic trading/risk infrastructure.  | Audited, transferable retail profitability.                                                          | Not adopted; reassess after first-venue selection. |
| Freqtrade / FreqAI  | Backtesting, directional-trading workflows, adaptive modeling, and separating training from inference. | That a specific strategy or RL environment is production-ready or profitable.                        | Not adopted; reassess after first-venue selection. |
| NautilusTrader      | Event-driven execution/replay foundation and a documented Kraken integration.                          | Full support for every required order primitive, or suitability as the sole on-chain execution core. | Not adopted; reassess after first-venue selection. |

A body of research on specialized, low-latency automated arbitrage is also part of the record (evidence that competitive, cost-sensitive automated arbitrage exists in public markets), but it is background evidence, not a framework candidate, and it establishes nothing about whether a retail LLM-assisted bot can capture the same economics after costs.

## On-chain identity rules

- An asset is identified by chain plus contract address or mint, or by native denomination — never by ticker alone. A matching ticker on the wrong chain or contract is treated as a different asset.
- An exchange's stablecoin balance and its withdrawal network are separate concepts; the selected withdrawal network must match the actual receiving wallet and token implementation.
- Native USDC, bridged USDC representations, distinct USDT implementations, and unrelated assets that happen to reuse a symbol are never assumed to share custody, liquidity, issuer support, transferability, or redemption risk.
- A bounded gas reserve in the chain-native asset is maintained wherever vigil holds on-chain inventory. A sponsored or gasless route still has a real economic cost and real limitations that must be disclosed, not assumed away.

## Stage ladder

A venue advances through these stages one at a time; evidence for one stage is never stretched to imply the next.

1. **Research-only** — primary documentation review; no credentials beyond public endpoints. Establishes the venue as a candidate and produces its initial verification checklist.
2. **Read-only market data** — account- or chain-observed read access (quotes, balances, instrument metadata) using read-only credentials. Confirms the venue's actual behavior matches its documentation for the account or chain being onboarded.
3. **Paper execution against recorded data** — the paper adapter exercises the full order or transaction lifecycle against recorded or live-read market data, with no real funds and no real signing. Confirms lifecycle, fee, and precision assumptions before any capital is at risk.
4. **Live canary** — a small, separately gated deployment behind everything [policy.md](policy.md)'s LIVE mode requires: a Verified capability record, an owner-approved policy with real numbers, isolated credentials, a passing fault-injection matrix, and a demonstrated pause and rollback. This stage is never reached by an environment variable alone.
