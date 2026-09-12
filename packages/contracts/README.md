# @vigil/contracts

The shared vocabulary every other workspace member and app is built on: zod
schemas and their inferred types for asset identity, money, timestamps, and
the research-to-execution pipeline. It is the bottom of the layer graph —
everything else depends on it, and it depends on nothing in this workspace.

## What it owns

- Asset identity (chain plus contract/mint address — never a ticker alone).
- Money and quantity types (decimal-string on the wire; see "What it must
  never do" below for the arithmetic boundary).
- The timestamp family: event, publish, first-seen, ingest, feature,
  analysis, intent, quote, submit, ack/inclusion, and fill/finality.
- `ResearchPacket`, `TradeProposal`, and `ApprovedEconomicIntent`.
- Reason codes (why a candidate was journaled as executed, rejected,
  expired, missed, or avoided).
- Operating modes: PAPER, SHADOW, LIVE, PAUSED.

## What it must never do

- Perform IO of any kind (no network, no filesystem, no database).
- Call an LLM or depend on anything that does.
- Depend on another workspace package or an app — it is the floor of the
  layer graph, not a participant in it.
- Add a decimal-arithmetic library. Money is never floating point, but which
  library represents it (`big.js`, `decimal.js`, or a hand-rolled integer
  base-unit type) is a decision for the first slice that implements this
  package, not a dependency added ahead of that decision.

## Allowed workspace imports

None. `zod` is the only runtime dependency.

## Planned modules

- `asset-identity` — chain/contract-address identity, never a bare ticker.
- `money` — the decimal-string wire type (`decimalStringSchema`,
  `DecimalString`, `DECIMAL_STRING_PATTERN`); no formatting or arithmetic.
- `timestamps` — the full timestamp family listed above, and freshness math.
- `research-packet` — the evidence bundle a research worker hands to policy.
- `trade-proposal` — a candidate before it is checked or approved.
- `approved-economic-intent` — the immutable, once-consumable approved unit.
- `reason-codes` — the enumerated reasons a candidate resolves the way it does.
- `operating-mode` — the PAPER / SHADOW / LIVE / PAUSED vocabulary
  (`OPERATING_MODES`, `operatingModeSchema`, `OperatingMode`); no transitions.

## Status

`money` and `operating-mode` exist. The other modules above are planned.
