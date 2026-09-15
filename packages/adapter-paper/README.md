# @vigil/adapter-paper

A simulated exchange. It implements the Exchange order lifecycle from
`docs/architecture.md` exactly — including `UNKNOWN` as a real state,
partial fills, and a reconciliation read that resolves them — and reports an
exact execution-economics breakdown for every fill, so the execution domain
can be built and fault-tested without a venue and small-trade costs are
visible rather than hidden inside a price.

It is the only execution adapter until a venue is selected, and the
convention it establishes — `packages/adapter-<venue>` — is how a live
adapter joins the workspace later.

## The one idea

**The venue's state and the caller's view of it are different things.**
`createPaperExchange` owns a private order book that is the venue's own
truth; a `PaperOrder` is what the caller managed to observe. Every fault
this package injects is a divergence between the two, and the
reconciliation read is the only thing that closes the gap — which is what
makes reconciliation a real operation here rather than reading back a
variable that was just written.

## The seam `apps/trading` drives

```text
proposeOrder  ->  validateOrder  ->  reserveOrder        the caller's steps
                      |
                      v
              exchange.submitOrder                        the venue's, from here on
                      |
        +-------------+---------------+
        |                             |
 exchange.pollOrder           exchange.cancelOrder
        |                             |
        +-------------+---------------+
                      |
        exchange.readVenueState  ->  exchange.reconcileOrder
                      |
                      v
                 settlementOf
```

`PROPOSED -> VALIDATED -> RESERVED` are the caller's transitions:
`apps/trading` ran the policy check and took the ledger reservation, so it
records that they happened. Everything from `SUBMITTING` onward belongs to
the venue. There is no exported way to move an order to `ACKNOWLEDGED`,
`PARTIALLY_FILLED`, or `FILLED` by hand — a fill is produced by an
execution or it does not exist.

## What it guarantees

- **No transition outside the diagram.** `ORDER_STATE_TRANSITIONS` is the
  diagram transcribed, every state change in the package goes through one
  guarded function, and an illegal move is a reason-coded refusal. The
  venue simulation throws on one, because a paper venue that can walk
  outside the lifecycle would have every suite built on it proving the
  wrong machine.
- **`UNKNOWN` never collapses.** A submission timeout leaves the order
  `UNKNOWN` whether or not the venue accepted it; the caller cannot tell,
  and there is no way to peek. Polling and cancelling are both refused
  until reconciliation has run.
- **Nothing is released on an unsettled order.** `settlementOf` reports
  `releasableRemainder: null` and `unspentInput: null` — not zero, not the
  remainder — for every non-terminal state. A partial fill that is still
  working, an `UNKNOWN` order, and an unconfirmed cancellation all release
  exactly nothing.
- **Filled exposure survives a cancellation.** After a partial fill is
  cancelled, the filled quantity, its notional, and the fee the venue
  charged all persist; only the confirmed unfilled remainder becomes
  releasable.
- **The residual is measured in the INPUT asset**, the one the action spends,
  never the output quantity it acquires. `settlementOf` reports
  `unspentInput` — `maxSpend` less what actually left — and
  `residualExceedsPermitted` compares that against the intent's
  `permittedResidual`, which denominates the same asset. The decision and its
  reasoning live on `permittedResidualBase` in
  `packages/db/src/schema/intents.ts`, the durable column this field
  projects; nothing converts between the two. Only a partial fill can raise
  the flag: an order that never filled leaves no position to decide about,
  and one that filled completely finished the action.
- **Reconciliation precedes resubmission.** Submitting again under a client
  order id the venue already holds is refused — `TRANSACTION_UNRESOLVED`
  while that order is still working, `IDEMPOTENCY_KEY_ALREADY_USED` once it
  is terminal. An approved intent is consumable exactly once.
- **An absence only means something in an authoritative read.** A
  `COMPLETE` reconciliation read that holds no record of an order confirms
  the venue never accepted it. An `INCOMPLETE` one confirms nothing by
  absence, and the order stays `UNKNOWN`.
- **The approved envelope binds, whatever pattern of fills delivers it.** A
  submission is refused before the venue sees it if the intent has expired,
  the quote fails `@vigil/market`'s freshness gate (`STALE_QUOTE`), the quote
  prices a different instrument, the book is crossed, or the whole order at
  the venue's capped price, fee and fixed cost would breach `maxSpend` or fall
  below `minAcceptableReceipt`. Two things make that a proof rather than an
  estimate: every execution fills at exactly the capped price, and every total
  is computed on the CUMULATIVE filled quantity, so a stepped fill costs
  exactly what the same quantity costs filled at once. Rounding each execution
  independently instead — as an earlier revision did — makes a stepped fill
  strictly dearer and carried real fills past an approved ceiling.
- **A cost is reported once, where it was charged.** Spread and slippage are
  `EMBEDDED_IN_PRICE` and are already inside `grossNotional`; the venue fee
  and the fixture's fixed cost are `SEPARATELY_CHARGED`. A buy's
  `netCapitalConsumed` equals `grossAtReferenceMid + totalIncrementalCost` and
  a sell's `netProceeds` equals `grossAtReferenceMid - totalIncrementalCost`,
  exactly, so double-charging is detectable rather than plausible.
- **A fill is traceable on its own.** Every execution carries its client order
  id, the venue's order id, and the full provenance of the approval behind it —
  the policy, strategy, model and snapshot versions. `readVenueState` flattens
  executions from every order into one list, so a fill read out of it has no
  parent record to inherit an identity from.
- **A reconciliation read has to cover the dispatch it resolves.** A report
  taken before an order was dispatched is authentic and still says nothing
  about it: its absence from that read means "not dispatched yet", never "the
  venue did not accept it".
- **The quote has to be a quote for this order.** An instrument id is exactly
  `baseAssetId/quoteAssetId`, so the order's own asset pair derives the id its
  quote must carry. A fresh, well-formed quote for another instrument is
  refused with `QUOTE_INSTRUMENT_MISMATCH` rather than silently pricing the
  fill.
- **Only a read this exchange issued resolves anything.** `reconcileOrder`
  accepts a report by object identity and then takes the state from the
  venue's own book, never from the report's rows, so neither a hand-built
  report nor one edited after it was taken can introduce a fill.
- **A dispatched intent is not dispatched again.** Two guards, because the
  order book alone is not enough: a submission the venue never accepted leaves
  no book entry, and the caller still holds its immutable `RESERVED` order.
  The guard lifts only when an authoritative read confirms the venue holds
  nothing, which is the legitimate reconcile-then-retry path.
- **The caller can always catch up with the venue.** When the venue moves two
  documented steps at once — a venue-initiated cancellation takes a resting
  order `ACKNOWLEDGED -> CANCEL_PENDING -> CANCELED` — the caller is walked
  along the same route, and through the fill state first when executions are
  being adopted, so nothing is ever left with no legal way forward.
- **Money is exact.** Decimal strings on the wire, `bigint` counts of units
  at a declared scale inside. Every rounding is the direction that cannot
  flatter vigil's accounting: a buyer's notional up, a seller's proceeds
  down, every fee up.
- **Determinism.** No clock read, no `Math.random`, no IO. Time arrives as a
  parameter; fills come from the behavior script or from a hash of (seed,
  client order id); prices come from the submitted quote. The same
  configuration driven through the same calls with the same timestamps
  produces identical records.

## Injecting a fault

Faults are declared per client order id in `PaperExchangeConfig`, so a
scenario is written rather than waited for:

```ts
const exchange = createPaperExchange({
  seed: 20_260_915,
  moneyScale: 2,
  quantityScale: 4,
  feeBasisPoints: 25,
  slippageBasisPoints: 0,
  behaviors: {
    "idem-0001": {
      // The venue accepted; the caller never heard. This is the
      // crash-shaped gap from docs/testing.md.
      submission: { kind: "TIMEOUT", venueAccepted: true },
      executions: { kind: "STEPS", steps: [{ quantity, afterMs: 0 }] },
      cancellation: { kind: "TIMEOUT" },
      resting: { kind: "EXPIRE", afterMs: 60_000, detail: "time in force" },
    },
  },
  reconciliationCoverage: "INCOMPLETE",
});
```

`PAPER_ADAPTER_CAPABILITY.injectableFaults` is the declared list. A
behavior deliberately cannot set an execution price: price comes from the
quote and the configured slippage cap and nothing else, so no scenario can
drive a fill outside the approved envelope.

## What it must never do

- Touch a live venue endpoint. There is no network client, no credential
  parameter, and no base URL in this package — not disabled, absent.
  `src/no-live-endpoint.test.ts` reads the package's own source and asserts
  those constructs stay absent, because nothing the compiler or the linter
  checks can tell "simulates a venue" from "has an unused HTTP client".
- Hold a real credential of any kind, or sign anything.
- Add a decimal-arithmetic library (see `packages/contracts/README.md`).

Only `apps/trading` may import this package (or any future
`packages/adapter-<venue>`) — see `docs/architecture.md` "Layer graph and
import rules".

## Allowed workspace imports

- `@vigil/contracts`
- `@vigil/market`

## Modules

| Module | Owns |
| --- | --- |
| `order-state` | The lifecycle table, the legality guard, and the state groupings a caller reasons with |
| `intent` | The execution-relevant subset of `ApprovedEconomicIntent`, parsed at the trust boundary |
| `order` | The immutable order record, the caller's three transitions, and `settlementOf` |
| `execution-economics` | What a fill cost: cumulative-exact totals, and the embedded-versus-charged breakdown |
| `exchange` | The simulated venue: submit, poll, cancel, the reconciliation read, and resolution |
| `faults` | The injection surface — submission, execution, cancellation, and resting behaviors |
| `capability` | The capability stamp an intent's `adapterCapabilityVersion` must name |
| `venue-math` | Exact `bigint`-on-scaled-integers arithmetic and the deterministic fill split |

## Reading a fill

`settlementOf(order)` returns the release half — what capital comes back —
and `economics`, the cost breakdown issue #33 requires:

| Field | What it is |
| --- | --- |
| `referenceBid` / `referenceAsk` | The top of book the simulation priced from |
| `referenceMid` | The midpoint, rounded so the measured spread is never understated |
| `referencePrice` | The executable side: the ask for a buy, the bid for a sell |
| `executionPrice` | Where every execution filled: the reference moved by the slippage cap |
| `grossAtReferenceMid` | What the filled quantity would have cost or yielded with no cost at all |
| `grossNotional` | Gross at the execution price — already contains the embedded components |
| `costs` | `SPREAD`, `SLIPPAGE`, `VENUE_FEE`, `FIXED_COST`, each with the amount and how it was charged |
| `embeddedCost` / `separatelyChargedCost` / `totalIncrementalCost` | The two halves and their sum |
| `netCapitalConsumed` / `netProceeds` | The side-appropriate net; the other is `null` |
| `netCashFlow` | Signed, and what the ledger posts |

Each execution reports its own exact INCREMENT of the running totals, not a
rounding of itself, so two executions of equal quantity can carry different
notionals and an execution can carry a zero fee. The increments sum to the
totals exactly; that is the point.

The components map onto `packages/policy`'s net-edge cost model directly:
`VENUE_FEE` is the rate-on-notional term, `SPREAD` and `SLIPPAGE` are the
per-unit terms, and `FIXED_COST` is the flat one. The `charging` marker is
what keeps the embedded pair from being subtracted a second time there.

## Known limits

Two edges a real venue has are absent because the lifecycle diagram does
not draw them, and inventing them here would put a transition into the
execution record that no document sanctions: a fill that lands after a
cancel request (`CANCEL_PENDING -> PARTIALLY_FILLED` / `-> FILLED`), and a
partially filled resting order that the venue expires
(`PARTIALLY_FILLED -> EXPIRED`). Both need an owner ruling and a change to
`docs/architecture.md` before this adapter can simulate them.
