# Venue evidence: what counts, what doesn't, how to record it

Every capability claim about a venue traces to exactly one of three source
tiers. Only two of them, held together, can move a `docs/capabilities.md` row
out of `Unverified`.

## Source tiers

| Tier | What it is | What it alone proves |
| --- | --- | --- |
| Primary documentation | The provider's own API reference, schema, changelog, chain/program source, or an on-chain read (chain id, deployed bytecode, program IDL) for the exact version in force | The provider *documents or exposes* the capability. It does not prove the account, pair, or wallet in front of you can actually use it. |
| Account- or chain-observed | A real call made against the account, API key, sandbox, or wallet actually being onboarded — an authenticated fee/permissions/limits response, an executed testnet or simulated transaction, a read against the actual chain state — captured with its request and response | The capability behaves as documented *for this account/pair/wallet at this observation time*. It does not prove a different account, tier, region, or a future revision behaves the same way. |
| Claims | Marketing pages, blog posts, forum threads, third-party aggregator sites, the private design handoff, or a prior model's confident restatement of any of these | Nothing on its own. A claim is a lead worth checking, never a citation. |

A website advertising a feature is a claim, not documentation, even when the
website belongs to the provider — check the actual API/program reference
before treating it as documented. An unauthenticated public endpoint response
is documentation-tier at best; it is not account-observed unless the exact
account or wallet being onboarded made the call.

## From evidence to row classification

`docs/capabilities.md` accepts exactly three states per venue/capability row:

- **Verified** — primary documentation **and** an account- or chain-observed
  result agree, both cited with the observation date. Neither tier alone is
  sufficient: documentation without observation is unproven for this account;
  observation without documentation is an unexplained one-off that cannot be
  trusted to generalize past the exact call made.
- **Unsupported** — verified absent. Either the provider's documentation
  explicitly excludes the capability (an exhaustive permissions list, an
  explicit "not supported" statement, an explicit rejection code with a
  documented meaning), or an observed call is explicitly refused for that
  reason and the refusal is captured. Silence in a non-exhaustive schema is
  not evidence of absence; leave it Unverified instead.
- **Unverified** — the default for everything else, including a capability
  supported by documentation alone, an account-observed result with no
  documentation to explain it, anything sourced only from a claim, and
  anything not yet attempted. Copying a figure or a supported-network list
  out of the design handoff, a blog post, or a competitor's docs page never
  produces anything better than Unverified.

Scope every result to the exact venue identity observed: exchange plus API
version plus the specific account/fee tier/pair, or chain id plus the
specific protocol/router/program address and its exact deployed version. A
result observed on one pair, one fee tier, one chain, or one contract address
does not transfer to a sibling pair, tier, chain, or address.

## How to record

Copy [the capability record template](../templates/capability-record.md) for
every venue/capability pair being classified. Fill in the source tier used,
the exact citation (a documentation URL and version/date, and the captured
request/response or observation for anything account- or chain-observed), and
the resulting classification.

Evidence has two homes, and a Verified or Unsupported row needs both:

1. **Owner-visible entry** — the observation date and classification are
   posted where the owner (Brian) actually sees them: the body or a comment
   of the GitHub issue driving the onboarding work, or the row's own citation
   in `docs/capabilities.md` when the citation is self-contained (a
   documentation URL plus an observation date is enough; a full
   request/response capture is not pasted into a durable doc or an issue).
   This satisfies "recorded with the observation date as an owner-visible
   evidence entry" — a classification with no owner-visible trace does not
   count as Verified or Unsupported, regardless of what evidence exists
   somewhere in a working file.
2. **Working evidence file** — the completed capability record, and any raw
   captured request/response, lives under gitignored
   `eval-output/venues/<venue>/`. Never commit raw run output, a captured
   credential-bearing request, or a full response body to `docs/` or any
   tracked path.

When a venue, chain, stablecoin, router, or signer choice becomes settled
project fact rather than an evaluated candidate, write the decision as an ADR
under `docs/decisions/`; the ADR cites the capability records that justified
it rather than restating their evidence inline.

## Boundaries that no amount of evidence changes

- A capability record is evidence, never authorization. It never itself
  raises a limit, changes the operating mode, or unlocks a trading stage.
- No probe this skill performs places a trade, moves funds, requests a seed
  or private key, or authenticates as anything other than a read-only,
  owner-supplied credential scoped to observation.
- No undocumented endpoint is called, and no logged-in browser session is
  automated, to fill a gap that the documented API leaves unsupported or
  unverified.
