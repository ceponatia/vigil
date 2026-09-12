# Venue capability record

Complete this record before changing any row in `docs/capabilities.md`. Save
the completed record under gitignored `eval-output/venues/<venue>/`, and post
the identity block plus the classification and citation for each capability
(not raw request/response captures) as an owner-visible entry — the driving
GitHub issue's body or a comment — per
[evidence states](../references/evidence.md). A record with no owner-visible
entry does not move a row.

## Identity

- Venue kind: [exchange, chain, protocol, router, or signer provider]
- Venue name and exact version: [name; API version, chain id, or program/
  policy version]
- Account/wallet scope observed: [account/key id or wallet address — never a
  secret value]
- Asset(s) involved: [chain + contract/mint, or native denomination] plus
  [withdrawal network, if applicable]
- Vigil stage targeted: [research-only, read-only market data, paper
  execution against recorded data, or live canary]
- Credential authorization: [who supplied the read-only credential, for what
  purpose, and confirmation it is not stored in the repository]
- Observation date: [date]

## Capability evidence

One row per capability checked (see
[exchanges](../references/exchanges.md) or
[on-chain](../references/on-chain.md) for the applicable checklist).

| Capability | Primary documentation (source + version/date) | Account/chain observed (yes/no + citation) | Classification | Notes |
| --- | --- | --- | --- | --- |
| [e.g., cancel-all excludes protective orders] | [URL + version/date, or "none found"] | [yes/no; captured request/response location under eval-output, or explorer tx/signature] | [Verified, Unsupported, or Unverified] | [scope limits, e.g., "this pair/tier/version only"] |

## Placement

- `docs/capabilities.md` row(s) updated: [row identity]
- `packages/db` venue/evidence reference updated: [module/row, or "none —
  research-only stage"]
- `packages/adapter-<venue>` mechanics this evidence justifies: [path, or
  "none yet — evidence does not clear this stage"]
- ADR opened under `docs/decisions/`: [path, or "not applicable — no
  decision settled yet"]

## Stage justification

- What this evidence actually supports: [research-only / read-only market
  data / paper execution / live canary — state the weakest-supported item
  above, not the strongest]
- What remains Unverified or Unsupported and blocks the next stage: [list]
- Money/authority actions taken during this observation: [must be "none";
  if not none, stop and escalate rather than completing this record]
