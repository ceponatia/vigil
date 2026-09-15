# @vigil/adapter-paper

A simulated exchange. It implements the Exchange order lifecycle from
`docs/architecture.md` exactly — including `UNKNOWN` as a real state,
partial fills, and a reconciliation read that resolves them — so the
execution domain can be built and fault-tested without a venue.

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
  `releasableRemainder: null` — not zero, not the remainder — for every
  non-terminal state. A partial fill that is still working, an `UNKNOWN`
  order, and an unconfirmed cancellation all release exactly nothing.
- **Filled exposure survives a cancellation.** After a partial fill is
  cancelled, the filled quantity, its notional, and the fee the venue
  charged all persist; only the confirmed unfilled remainder becomes
  releasable, and the settlement flags it when that remainder is larger
  than the intent's `permittedResidual`.
- **Reconciliation precedes resubmission.** Submitting again under a client
  order id the venue already holds is refused — `TRANSACTION_UNRESOLVED`
  while that order is still working, `IDEMPOTENCY_KEY_ALREADY_USED` once it
  is terminal. An approved intent is consumable exactly once.
- **An absence only means something in an authoritative read.** A
  `COMPLETE` reconciliation read that holds no record of an order confirms
  the venue never accepted it. An `INCOMPLETE` one confirms nothing by
  absence, and the order stays `UNKNOWN`.
- **The approved envelope binds.** A submission is refused before the venue
  sees it if the intent has expired, the quote fails `@vigil/market`'s
  freshness gate (`STALE_QUOTE`), or the whole order at the venue's capped
  price and fee would breach `maxSpend` or fall below
  `minAcceptableReceipt`. Because every execution fills at exactly that
  capped price, no fill the venue produces can land outside the envelope.
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
| `exchange` | The simulated venue: submit, poll, cancel, the reconciliation read, and resolution |
| `faults` | The injection surface — submission, execution, cancellation, and resting behaviors |
| `capability` | The capability stamp an intent's `adapterCapabilityVersion` must name |
| `venue-math` | Exact `bigint`-on-scaled-integers arithmetic and the deterministic fill split |

## Known limits

Two edges a real venue has are absent because the lifecycle diagram does
not draw them, and inventing them here would put a transition into the
execution record that no document sanctions: a fill that lands after a
cancel request (`CANCEL_PENDING -> PARTIALLY_FILLED` / `-> FILLED`), and a
partially filled resting order that the venue expires
(`PARTIALLY_FILLED -> EXPIRED`). Both need an owner ruling and a change to
`docs/architecture.md` before this adapter can simulate them.
