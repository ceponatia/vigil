# Product

vigil's product mandate, in the owner's own words and requirements, sanitized of personal account detail. This page is the canonical statement of what the application is for; [policy.md](policy.md) governs how money and authority are constrained while pursuing it, and [capabilities.md](capabilities.md) tracks which parts of the mandate are actually verified to work.

## Goal

Build an intelligent, autonomous crypto research, trading, and yield-allocation application that rapidly and consistently looks for:

1. Arbitrage and price-dislocation opportunities.
2. Profit-taking and other directional trading opportunities, including entry selection, staged additions, portfolio rotation, partial exits, and thesis-driven exits.
3. Longer-term yield opportunities, including staking, lending, and potentially liquidity provision on approved venues.

The application learns from mistakes, distinguishes decision quality from luck, identifies genuinely missed opportunities, and improves from recorded outcomes. It demonstrates whether it adds value beyond simpler trading rules or passive holdings.

Owner ruling (2026-09-12): venue selection is not restricted to any single exchange. Approved exchanges and dedicated on-chain wallets are both in scope, chosen by total execution economics and risk.

## Explicit owner requirements

| ID   | Requirement                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| U-01 | Use API credentials for LLM analysis and exchange trading connectivity, including Kraken as an initial venue.             |
| U-02 | Translate the behavior of the owner's existing advisory trading tasks into a persistent application.                      |
| U-03 | Scan markets rapidly and consistently, rather than depending on hourly human-readable checks.                             |
| U-04 | Find arbitrage, profit-taking, and longer-term yield opportunities.                                                       |
| U-05 | Trade autonomously with capital the owner deliberately makes available; do not require approval for every ordinary trade. |
| U-06 | The owner personally supplies USD funding; the application cannot draw additional money from a bank account.              |
| U-07 | Learn from mistakes and missed opportunities using recorded evidence and outcomes.                                        |
| U-08 | Investigate existing trading bots and frameworks and credible evidence of success rather than building blindly.           |
| U-09 | Use advanced, reliable analytical methods, emphasizing meaningful intelligence over superficial agent complexity.         |
| U-10 | Do not restrict the design to Kraken; evaluate lower-cost on-chain trades and swaps funded through an exchange on-ramp.   |
| U-11 | Consider stablecoins such as USDC, USDT, or suitable alternatives on the relevant chains as settlement/funding assets.    |
| U-12 | Produce documentation sufficient to initialize a repository and GitHub Project — satisfied by this documentation set.     |

## Behavioral requirements inherited from the owner's advisory tasks

Before this application existed, the owner ran two advisory research tasks — one covering the Cosmos/IBC ecosystem, one covering the Coinbase-tradable universe — that produced recommendations for a human to act on manually. Their behavioral requirements carry forward as product requirements for vigil; their instruction to never execute a trade does not, because vigil is a different system with its own execution authority.

| ID      | Required behavior                                                           | Implementation consequence                                                                                                     |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| TASK-01 | Distinguish an attractive earlier price from an entry still actionable now. | Validate current executable prices/depth and quote age immediately before submission.                                          |
| TASK-02 | Prefer missing an entry to chasing.                                         | Every entry has a zone, expiry, invalidation, and allowed extension.                                                           |
| TASK-03 | Research multiple horizons.                                                 | Separate 30/90-day, six/twelve-month and longer context from minute-level execution features.                                  |
| TASK-04 | Screen widely, research selectively.                                        | Cheap numerical screening feeds a bounded active candidate set and LLM research queue.                                         |
| TASK-05 | Revisit the original thesis.                                                | Positions link to versioned evidence, catalysts, horizon, and invalidation conditions.                                         |
| TASK-06 | Use staged entries and exits.                                               | Tranches are bounded, idempotent position-plan steps, not fresh unlimited authorizations.                                      |
| TASK-07 | Account for lockups and actual liquidity.                                   | Available, reserved, staked, unbonding, pending-transfer, and exit-queued balances are distinct.                               |
| TASK-08 | Learn from missed opportunities honestly.                                   | Log eligible candidates before their outcomes, including rejected candidates that later lose money.                            |
| TASK-09 | Compare alternatives.                                                       | Evaluate BTC, ETH, cash, and continuing to hold the asset proposed as the funding source.                                      |
| TASK-10 | Do not overcorrect from one adverse move.                                   | Separate timing evidence, process defects, and normal uncertainty across mature outcome cohorts.                               |
| TASK-11 | Avoid low-quality hype and weak fundamentals.                               | Liquidity, tokenomics, security, adoption, and evidence-quality gates precede capital allocation.                              |
| TASK-12 | Do not manufacture activity.                                                | WAIT, HOLD, AVOID, and no notification are valid outputs.                                                                      |
| TASK-13 | Be portfolio-aware.                                                         | Value holdings in USD, aggregate related exposures, account for correlations and liquidity, and identify real funding sources. |
| TASK-14 | Report concrete actionable plans.                                           | Store asset quantities and USD values, entry/exit conditions, horizon, strongest opposing case, costs, and invalidation.       |

## Research universes

A research universe is a screening seed, not an allowlist and not a record of holdings. Membership makes an asset eligible for numerical screening and LLM research; it grants no execution eligibility, no approval, and no target allocation on its own.

- **Cosmos/IBC ecosystem seed:** ATOM, OSMO, TIA, INJ, AKT, DYDX, AXL, NLS, BLD, STRD, JUNO, and other materially relevant Cosmos/IBC assets that emerge over time.
- **Coinbase-tradable universe seed:** the set of assets tradable on Coinbase, screened for asymmetric multi-week-to-multi-month setups rather than a generic short-term mover list.

Execution eligibility for any asset in either seed requires its own chain-plus-contract/mint identity, liquidity, and policy checks, applied at the time a candidate is actually proposed.

## Action vocabulary

vigil preserves the following action distinctions end to end, from research output through the dashboard: **BUY, SMALL STARTER, ADD, MISSED ENTRY / WAIT, WAIT FOR PULLBACK, HOLD, TRIM, SELL, EXIT, AVOID.**

Internal enums may collapse some of these into a smaller set of machine-actionable states, but the collapse has one hard limit: a candidate classified as a missed entry that is no longer attractive at the current price never becomes BUY. It stays WAIT/MISSED, with the original entry zone and the reason it is no longer actionable preserved alongside it.

## Success criteria

> Research continuously, react quickly, trade selectively, and measure whether the intelligence actually adds value after costs.

Evaluate net, risk-adjusted outcomes against contemporaneous USD/cash, BTC, ETH, and the relevant passive held-asset benchmark. Separate asset selection, timing, execution, yield income, and exposure to a broad rising market from one another so a lucky market does not read as skill.

Success is **not** trade frequency, win rate alone, gross spread, token-denominated APY, a flattering backtest, an LLM's verbal confidence, or a persuasive explanation after a loss. Refusing a trade whose expected advantage is smaller than its costs is correct behavior, not inactivity to fix.

No profitable return, loss ceiling, audited performance record, or commercial viability is established for vigil. [evaluation.md](evaluation.md) owns how that evidence is eventually built.

## Decision register

| Topic                   | Current position                                                                        | Status                                      |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| Execution venues        | Approved exchanges and dedicated on-chain wallets; no single exchange is exclusive.     | User clarification                          |
| Fiat funding            | The owner manually supplies capital; the application has no access to bank funding.     | User requirement                            |
| Normal trading          | Autonomous within an explicit mandate.                                                  | User requirement                            |
| LLM role                | Research, evidence synthesis, proposals, and evaluation; no raw financial authority.    | Proposed design                             |
| Financial authority     | Isolated deterministic execution/signing boundary with non-rewritable limits.           | Proposed design                             |
| Initial product         | Personal pilot; a public/multi-user product remains unanswered.                         | Provisional scope                           |
| Initial chain           | Base provisionally preferred; Solana is a serious alternative.                          | Not selected                                |
| Settlement asset        | Native USDC provisionally preferred; USDT/other assets may be enabled after evaluation. | Not selected                                |
| Routing                 | Evaluate 0x for EVM and current Jupiter APIs for Solana.                                | Research/build candidate                    |
| Trading framework       | Evaluate NautilusTrader, Hummingbot/Condor, and Freqtrade/FreqAI.                       | Not selected                                |
| Leverage                | Spot/unleveraged pilot; no margin, perpetuals, borrowing, or leveraged yield loops.     | Proposed default, not owner-approved policy |
| Risk limits             | Numerical limits are discussion defaults only.                                          | Unapproved                                  |
| Operating budget        | Separate from trading capital; exact ceiling not set.                                   | Proposed control; amount open               |
| Initial deployment      | Paper/shadow first; a manually approved small live canary later.                        | Proposed delivery plan                      |
| Project/repository name | vigil (working name); may be renamed.                                                   | Provisional                                 |

## Superseded assumptions

An earlier, Kraken-only design was superseded by the owner's clarification that execution is not limited to one exchange. These assumptions from that earlier design do not survive:

| Original assumption                                                        | Current interpretation                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Live execution is restricted to Kraken.                                    | Superseded. Use approved execution adapters with venue-aware costs and risk.                                             |
| External wallets are an initial blanket non-goal.                          | Superseded as a product restriction. A dedicated constrained wallet can be the first execution venue.                    |
| All external DeFi must remain research-only indefinitely.                  | Superseded. Live approved DeFi is in scope, but each integration needs its own capability and security gate.             |
| No component may ever sign an external transaction.                        | Replaced by an isolated, policy-constrained signer. No LLM or research worker gets a private key or unrestricted signer. |
| Arbitrage means only Kraken triangular cycles.                             | Expanded to same-chain atomic opportunities, and later prefunded multi-venue opportunities.                              |
| Keep the trading reserve entirely as USD on Kraken.                        | Reserve composition and location are revisited: USD, approved stablecoins, and a bounded chain-native gas reserve.       |
| NautilusTrader's Kraken adapter is the likely center of the entire system. | Reassessed after the first live venue is selected; a framework may be one adapter, not the core of on-chain execution.   |
| Second exchange / external wallet is necessarily the last delivery phase.  | The first useful vertical slice may instead use one chain and one approved swap route.                                   |

What still holds from before the clarification: separating research from authority, manual funding, separate financial and operating budgets, accurate accounting, current-entry checks, coordinated exits, outcome logging, shadow evaluation before live promotion, and safe recovery from failure.

## Deferred scope

Unrestricted multi-chain custody, general-purpose signing, arbitrary bridges, flash loans, borrowed capital, public customer accounts, unattended self-modifying production code, and every strategy on every chain are not part of the initial build. The architecture allows approved expansion later without pre-building every adapter, issuing speculative infrastructure work, or standing up empty service scaffolds ahead of need.

## Open owner decisions

| Decision                   | What is still needed                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Initial and future capital | Starting allocation and expected future manual deposits.                                                                |
| Loss tolerance             | Drawdown that should stop new risk; maximum tolerated total experimental loss; approved per-trade/concentration policy. |
| Operating spend            | Monthly ceiling for LLM calls, hosting, RPC, and optional data; any existing accounts to use.                           |
| Mandated assets            | Whether every allocated asset may be sold, or whether specific core holdings are protected.                             |
| First chain                | Base, Solana, or another chain, after capability/economic comparison.                                                   |
| Settlement assets          | Preferred USDC/USDT/other token and reserve composition, including stablecoin exposure limits.                          |
| Custody/signing            | Managed policy wallet versus self-managed isolated signer; initial funding and administration procedure.                |
| Treasury authority         | Whether later automated exchange withdrawals, allowlisted transfers, gas purchases, or bridges are approved.            |
| LLM provider               | Preferred provider/model family; API account; spend and data-retention constraints.                                     |
| Hosting                    | Approved provider/budget and whether an always-on service is desired initially.                                         |
| Product scope              | Strictly personal versus eventual external users.                                                                       |
| Repository identity        | Final name (vigil is the working name), visibility, and license.                                                        |
| Go-live                    | Which evidence and manual action approve the first small live canary.                                                   |

## Safe defaults while decisions are open

An open decision above does not block a local, paper-only skeleton using synthetic balances and no secrets. Until each row resolves:

- PAPER is the default operating mode.
- One synthetic instrument/route and one simple numerical strategy are enough to prove the lifecycle.
- Arithmetic stays exact; no real signing or order endpoint is reachable.
- LIVE stays behind its explicit capability gate — see [policy.md](policy.md).
- No paid infrastructure is provisioned without owner approval.
- No holding is assumed protected as a core position unless the owner explicitly designates it.
- The unapproved example risk values in [policy.md](policy.md) carry no implicit approval.
