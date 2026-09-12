# Exchange onboarding

An exchange enters `docs/capabilities.md` as a set of independent capability
rows, not one pass/fail verdict. Verify each item below against the exact API
version and the exact account/key/pair being onboarded; read
[evidence states](evidence.md) first for what counts as documentation versus
an account-observed result.

Use only the credential the owner has supplied for this purpose, scoped to
the minimum permission the check needs. Never place an order, never move
funds, and never touch an Earn/staking allocation to "see what happens" —
each item below has a read-only or documentation-only verification path.

## Identity and access

- **API version and base surface.** Record the exact API version/generation
  in force (REST and, separately, WebSocket if the exchange versions them
  independently) and the exact date the documentation was read. An older
  cached doc page is a claim, not documentation.
- **Permissions model.** Enumerate the exchange's actual permission
  groups/scopes (read/accounting, trade, withdraw, Earn/staking, etc. — named
  as the exchange itself names them) and confirm which the onboarded key
  actually carries by an account-observed permissions/key-info call, not by
  what was requested at creation. Record whether the exchange's own groups
  are coarser than the capability actually needed, and whether an
  application-side endpoint allowlist is required to narrow it further.
- **Fee tier, as observed for this account and pair.** Query the account's
  actual current fee schedule for the exact pair and product category (an
  exchange may treat a stablecoin/FX pair differently from an ordinary spot
  pair) via the account-level endpoint, not the public marketing schedule.
  Record maker and taker separately, the category the exchange assigns the
  pair to, and the observation date — fee tiers move with volume and
  promotions and are never treated as a fixed constant.
- **Rate limits.** Record the exchange's documented limit model (per-key,
  per-IP, weighted-endpoint, or tiered by account activity) and confirm the
  actual response headers/behavior on an account-observed call, including
  what the exchange returns on exceeding it and whether that response is
  distinguishable from a transient failure.
- **Reconnect behavior.** For any streaming/WebSocket surface used for
  private data, record the documented and observed behavior on disconnect:
  whether a session/sequence token survives, whether snapshots must be
  re-requested, and whether missed private events (fills, order state
  changes) are ever silently unrecoverable versus requiring a REST
  reconciliation pass.

## Order mechanics

- **Precision and minimums.** Record the exact price/quantity precision and
  minimum order size/notional for the pair, from the instrument-metadata
  endpoint, not a rounded example. Round down to the documented precision;
  never round a computed size up past its risk budget to clear a minimum.
- **Time-in-force.** Record which time-in-force values the pair's order type
  actually accepts (e.g., good-til-cancel, immediate-or-cancel,
  fill-or-kill, post-only/maker-only) and any documented or observed deadline
  semantics.
- **Partial fills.** Record whether the order type can partially fill, how
  partial-fill events are reported (a single mutable order record versus a
  stream of fill events), and whether an amendment/replace operation on a
  partially filled order is supported or requires cancel-and-resubmit.
- **Protection primitives.** Record whether the exchange offers a real
  stop, OCO (one-cancels-other), or bracket order as a primitive the API can
  place and query — not a client-side feature only visible on the trading
  website. State explicitly whether the primitive is persistent on the
  exchange's own matching engine (survives the application being offline) or
  requires the application to be connected and running to enforce it. Treat
  a website-only stop/bracket feature as Unsupported for API purposes until
  the API is shown to expose it.
- **Cancel-all semantics.** Record exactly what a cancel-all (or
  cancel-all-after/dead-man's-switch) call cancels: does it include
  protective stop/OCO orders, or only ordinary open orders? Confirm by
  observation, not by the name of the endpoint — a "cancel all" facility is
  not a liquidation facility unless the documentation says so, and canceling
  a protective order as a side effect of an emergency action can leave a
  position naked. This item gates whether the venue's emergency "cancel
  everything" control (see the on-chain reference's protection section for
  the on-chain analog) is safe to wire without also closing exposure.

## Custody and transfers

- **Withdrawal networks.** For each asset intended to leave the exchange,
  record the exact set of withdrawal networks the exchange currently
  supports for that asset, and confirm the token identity on each network
  (contract/mint address, not just a network name) matches the intended
  receiving wallet's expected asset — a symbol match alone is not identity;
  see [on-chain asset identity](on-chain.md) for the receiving side.
  Withdrawal-network availability is account- and region-gated and changes
  over time; treat a supported-networks list carried over from any prior
  conversation or document as Unverified until reconfirmed against the
  actual account.
- **Holds and minimums.** Record actual observed funding-method-specific
  holds (e.g., a hold tied to a specific deposit method) and withdrawal
  minimums for the asset/network pair, distinguishing a documented policy
  from an account-specific hold that only appears once triggered.
- **Earn-style products.** Classify separately: (1) an exchange-native
  staking/Earn product with a documented, callable API for allocation,
  balance, and redemption; (2) an exchange-branded embedded-wallet or DeFi
  product whose API surface is not established; (3) anything visible only on
  the exchange's website with no corresponding API call. Only class (1),
  account-observed, can reach Verified; do not assume a branded product
  named alongside "Earn" shares the same API.

## Recording

Use [the capability record template](../templates/capability-record.md), one
row per capability above, with the exact account/pair/version scoping named
in each item. State which stage — research-only, read-only market data, paper
execution, or live canary — each observed result actually supports; a
successful account-observed permissions or fee-tier check supports read-only
market data at most until order-placement and cancellation behavior are
separately verified against a paper or sandboxed path.
