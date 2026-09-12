# On-chain onboarding: chains, protocols, routers, and signer providers

A chain, a protocol/pool, a router/aggregator, and a signer provider are four
distinct venue kinds and each gets its own capability rows in
`docs/capabilities.md` — a router being verified on a chain says nothing
about a signer provider's policy engine on that same chain. Read
[evidence states](evidence.md) first for what counts as documentation versus
an observed result; here, "account-observed" means observed against the
actual dedicated wallet and the actual chain (mainnet reads, and testnet or
simulated transactions where available), never a value assumed from a
different chain, a different router version, or a different signer product.

No item below places a trade, moves funds, or requires a seed or private key.
Reads use public RPC/explorer endpoints or a read-only wallet address;
transaction construction stops at simulation.

## Chain and asset identity

- **Chain id and network.** Record the exact chain id (and, for a rollup or
  L2, which settlement layer it posts to) for the network actually being
  targeted — mainnet, not a same-named testnet — from the chain's own
  documentation or a direct RPC call, not an aggregator site.
- **Native gas asset and reserve rules.** Record the chain's native gas
  asset, and any protocol-level minimum-balance or rent/reserve requirement
  that is not itself gas (e.g., an account-existence reserve). State the
  intended gas-reserve replenishment rule and stranded-dust treatment as
  open items if not yet decided — do not invent a reserve percentage here;
  that is a policy decision, not a capability fact.
- **Canonical versus bridged token identity.** For every asset, record the
  exact contract address (EVM) or mint address (Solana) — or the native
  denomination when the asset is chain-native — actually held or targeted,
  not a ticker. Explicitly distinguish a canonical/issuer-native
  representation from a bridged representation (a wrapped, bridged, or
  liquid-staked variant reusing a similar symbol): confirm via the issuer's
  own published contract/mint registry or the chain's official token list,
  never by symbol match on a block explorer's search box, which frequently
  surfaces unrelated or spoofed tokens using the same symbol. Record
  issuance/redemption path, and whether the representation is the one the
  intended withdrawal network (see [exchanges](exchanges.md)) actually
  delivers.

## Routers, aggregators, and pools

- **Quote fields.** Record the exact fields a router/aggregator's quote
  response returns for the version in force: input/output amounts, minimum
  output or maximum slippage parameter, route/hop breakdown, price impact,
  quote expiry/validity window, and any platform or aggregator fee embedded
  in the quote versus charged separately. Note the exact API/contract
  version, since routing behavior and fee structure are version-sensitive
  (a router may offer more than one execution path — e.g., a managed
  meta-aggregation path versus a raw-instruction path — with different fee
  and control tradeoffs; treat each as a separately verified path).
- **Transaction content.** Before any transaction is ever signed, record
  what the router/aggregator actually asks to be signed: the destination
  contract(s)/program(s), the method(s) called, whether the payload contains
  nested calls to additional contracts, and whether the visible destination
  (e.g., an allowlisted router address) can itself embed instructions that
  move value to a different address. An allowlisted top-level address is not
  sufficient verification by itself.
- **Same-chain atomicity.** Record whether the specific route actually
  enforces its stated ending inventory/proceeds within one atomic
  transaction, or merely chains dependent calls that can partially execute
  or be sandwiched. Atomicity is a property of the specific route and
  contract, never a property of "being on the same chain" in general.
- **Simulation availability.** Record whether the chain/RPC/router exposes a
  pre-broadcast simulation (call, dry-run, or preflight) for the exact
  transaction shape used, and what a simulation result does and does not
  guarantee — simulation is evidence toward Verified, never proof of
  eventual inclusion or of safety against state that changes between
  simulation and broadcast.

## Allowances and approvals

- **Allowance/spender policy.** Record the exact spender address a token
  approval grants to, the amount the router/protocol actually requires
  (exact-amount versus unlimited/infinite approval), and whether the
  protocol's own documentation recommends or requires an unlimited
  approval. An unlimited approval is a standing capability grant to the
  spender's current and future code, not a one-time transaction, and is
  never the default; record the minimal sufficient allowance path when the
  protocol supports one (exact-amount approval, permit-style signature, or
  periodic re-approval).

## Lifecycle and finality

- **Finality, replacement, and expiry.** Record the chain's actual finality
  model (probabilistic confirmation depth, single-slot/fast finality,
  optimistic/fraud-proof or validity-proof settlement delay) and its actual
  rules for nonce reuse/replacement (EVM: replace-by-fee semantics; Solana:
  blockhash expiry and transaction re-signing), separately from any other
  chain already onboarded — these do not generalize across chains. Record
  what "pending" versus "unknown" looks like on this chain when a broadcast
  times out, and what reconciliation path (querying by hash/signature,
  nonce, or slot) resolves it.
- **Reorg and reversal.** Record whether the chain has an observed or
  documented history of reorganizing already-included blocks past the
  depth the application would otherwise treat as final, and what depth this
  venue's finality rule is actually set to require before treating a fill as
  settled.
- **MEV and inclusion.** Record whether the chain/mempool model exposes
  transactions to public front-running/sandwiching before inclusion, what
  private-relay or inclusion-protection options exist (and their cost or
  latency tradeoff), and whether the router's slippage/minimum-output
  parameter is the actual enforcement mechanism against adverse execution or
  merely advisory.

## Signer-policy capabilities

Apply this section to any policy-controlled signer/wallet-infrastructure
provider under consideration — no such provider is selected; verify each
candidate independently and do not assume one provider's policy engine
matches another's model or terminology.

- **Recipient constraints.** Record whether the provider can restrict
  signable transactions to an allowlist of recipient addresses, and whether
  that allowlist check inspects only the top-level `to` address or also
  constrains addresses reachable via nested/internal calls.
- **Asset constraints.** Record whether the policy can restrict which
  token contracts/mints or native asset a signature is permitted to move.
- **Spend constraints.** Record whether the policy can cap the amount
  (absolute, or per time window) a single signature or a rolling period is
  permitted to move, and whether that cap is enforced by the signer
  infrastructure itself or only advisory in a client library the
  application could bypass.
- **Nested-call constraints.** Record whether the policy engine decodes and
  constrains calls a transaction makes into other contracts (not just the
  top-level call), since an allowlisted top-level destination can otherwise
  embed an arbitrary internal transfer. This is the same hazard as
  "transaction content" above, verified here at the signer layer instead of
  the router layer.
- **Fee constraints.** Record whether the policy can cap gas/priority-fee
  spend per signature or per period, separate from the asset-spend cap.
  Failed/reverted transactions still cost fees and must be checked against
  this cap.
- **Policy administration.** Record who can create, modify, or remove a
  policy, whether the trading/research application itself has any path to
  alter its own restricting policy (it must not), and whether policy changes
  are logged in a way the owner can audit independently of the application.
  A signer product is not Verified for use until this item is confirmed:
  the value of every other constraint above depends on the application
  being unable to loosen it.

## Recording

Use [the capability record template](../templates/capability-record.md), one
row per capability above, scoped to the exact chain id, contract/mint or
program version, and — for a signer provider — the exact product and policy
version observed. State which stage the observed result actually supports;
a successful read-only quote or simulation supports read-only market data or
paper execution against recorded data at most, never a live canary, until the
signer-policy administration item above is independently confirmed.
