import type { AssetId, IsoUtcTimestamp } from "@vigil/contracts";
import { settlementOf } from "@vigil/adapter-paper";
import type { OrderSettlement, PaperOrder } from "@vigil/adapter-paper";
import { loadApprovedIntent, postJournalEntry, recordAttemptOutcome } from "@vigil/db";
import type {
  ExecutionAttemptStateValue,
  StoreApprovedIntent,
  StoreEntry,
  StoreLine,
  VigilDatabase,
} from "@vigil/db";
import { buildEntry } from "@vigil/ledger";
import type { EntryKind, JournalEntry } from "@vigil/ledger";

import { attemptStateFor, type ExecutionRuntime, type Instrument, sideFor } from "./dispatch";
import { executionRefusal, fromAdapterRefusal, type ExecutionRefusal } from "./diagnostics";
import { unitsAt } from "./venue-economics";

/**
 * settle.ts — what the venue actually did, recorded against what was
 * expected of it.
 *
 * Three operations reach the venue from here — polling, cancellation, and
 * the reconciliation read — and every one of them ends in the same place:
 * the attempt row carries the venue's **confirmed cumulative** spend and
 * receipt, and a terminal outcome is journaled once.
 *
 * ## Confirmed, cumulative, and forward-only
 *
 * `recordAttemptOutcome` takes totals, not deltas, and the lifecycle trigger
 * refuses a write that lowers either — a redelivered fill would otherwise
 * double-count, and a reconciliation that disagrees with durable history is
 * an incident to record rather than an edit that erases it. The totals come
 * from `settlementOf`, which computes them on the cumulative filled quantity
 * rather than by summing independently rounded executions, so they are the
 * same numbers whatever pattern of fills produced them.
 *
 * ## Why the journal waits for a terminal state
 *
 * A live `PARTIALLY_FILLED` order's exposure is real and is recorded — on
 * the attempt, where it moves forward as the venue confirms more — but it is
 * not posted to the ledger until the outcome is final. Posting at every poll
 * would either write one entry per observation (double-counting the same
 * fill) or reuse one idempotency key (silently dropping the larger, later
 * posting, because `postJournalEntry` answers a repeated key with the entry
 * that already exists). `docs/architecture.md` keeps the venue's own fills in
 * the `orders` record family, which is not built; until it is, the ledger
 * records the settled movement and the attempt records the running one.
 *
 * No realized P&L is posted anywhere here. A realized gain or loss needs a
 * position basis, which this slice does not maintain — and an unfilled or
 * `UNKNOWN` quantity is never reported as realized anything.
 *
 * ## Release, and the one condition that makes it safe
 *
 * Only a **terminal attempt that actually spent something** releases its
 * unspent remainder. That is not caution for its own sake: a terminal
 * attempt with a confirmed spend has consumed the intent — the partial
 * unique index over `execution_attempts` where `spent_base > 0`, and the
 * guard trigger beside it, make a further attempt on that authorization
 * impossible — so the capital the release hands back can never be needed by
 * a retry. A terminal attempt that spent nothing leaves its hold exactly
 * where it is, because the authorization is still open to a versioned retry
 * and releasing would leave that retry dispatching against capital nobody
 * holds.
 *
 * What this cannot do is move the `reservations` row out of `active`:
 * `@vigil/db` exports `reserveAvailable` and `loadActiveReservations` and no
 * state transition at all. So after a release the balances are right and
 * `loadActiveReservations` still reports the hold. That over-reports
 * commitments, which under-reports available funds — the conservative
 * direction — but it is a genuine divergence between two durable records and
 * it has to close before a second authorization runs against the same
 * capital.
 */

/** The ledger entry ids this settlement may post. Injected so a replay is byte-identical. */
export type SettlementIdentities = {
  readonly tradeEntryId: string;
  readonly feeEntryId: string;
  readonly releaseEntryId: string;
};

export type SettleRequest = {
  readonly intentId: string;
  readonly attempt: number;
  readonly instrument: Instrument;
  /** The caller's current view of the order. Every operation returns a new one. */
  readonly order: PaperOrder;
  readonly now: IsoUtcTimestamp;
  readonly ids: SettlementIdentities;
};

export type ReconcileRequest = SettleRequest & {
  /**
   * The reconciliation this outcome comes from. Required to leave `UNKNOWN`,
   * and a *new* one each time: an attempt that went unknown twice cannot be
   * resolved by the reconciliation that settled it the first time.
   */
  readonly reconciliationId: string;
};

export type AttemptSettlement = {
  readonly outcome: "recorded";
  readonly order: PaperOrder;
  readonly attemptState: ExecutionAttemptStateValue;
  readonly settlement: OrderSettlement;
  /** Confirmed cumulative input-asset base units consumed. */
  readonly spentBase: bigint;
  /** Confirmed cumulative output-asset base units received. */
  readonly receivedBase: bigint;
  /**
   * Input-asset base units handed back to `available`, or `null` when nothing
   * was released — either because the outcome is not confirmed, or because
   * nothing filled and the authorization is still open to a retry.
   */
  readonly releasedBase: bigint | null;
  /** The ledger entries this settlement posted, in posting order. */
  readonly journaledEntryIds: readonly string[];
  /**
   * Set when the confirmed spend exceeded the authorization's own ceiling.
   * The overspend has already happened at the venue, so it is surfaced
   * beside the record rather than instead of it — refusing to persist it
   * would blind the application to real exposure.
   */
  readonly overspend: ExecutionRefusal | null;
};

export type SettleResult = AttemptSettlement | { readonly outcome: "refused"; readonly refusal: ExecutionRefusal };

const refused = (refusal: ExecutionRefusal): { readonly outcome: "refused"; readonly refusal: ExecutionRefusal } => ({
  outcome: "refused",
  refusal,
});

/**
 * Takes up whatever the venue has reported since the last look and records
 * it. A poll never advances an order the venue has not moved, and it never
 * touches an order whose fate is unresolved — `UNKNOWN` and `CANCEL_PENDING`
 * accept no operation but reconciliation (`docs/resilience.md` §3).
 */
export async function pollAttempt(runtime: ExecutionRuntime, request: SettleRequest): Promise<SettleResult> {
  const polled = runtime.exchange.pollOrder({ order: request.order, now: request.now });
  if (polled.outcome === "REFUSED") {
    return refused(fromAdapterRefusal(polled.refusal));
  }
  return recordSettlement(runtime, { ...request, order: polled.order }, null);
}

/**
 * Requests a cancellation and records what came back.
 *
 * A confirmed cancellation is terminal and settles. A cancellation whose
 * confirmation was lost leaves the order at `CANCEL_PENDING` — the state
 * that means requested and not confirmed — which releases nothing and
 * accepts nothing further until reconciliation. This function builds no
 * retry, no timer and no incident: the cancellation-chase driver is a
 * separate concern, and what it needs from here is that the unresolved
 * state is durably visible, which `CANCEL_PENDING` on the attempt row is.
 */
export async function cancelAttempt(runtime: ExecutionRuntime, request: SettleRequest): Promise<SettleResult> {
  const canceled = runtime.exchange.cancelOrder({ order: request.order, now: request.now });
  if (canceled.outcome === "REFUSED") {
    return refused(fromAdapterRefusal(canceled.refusal));
  }
  return recordSettlement(runtime, { ...request, order: canceled.order }, null);
}

/**
 * Resolves an unconfirmed attempt against the venue's own state.
 *
 * The read is taken now, so it necessarily covers the dispatch it is being
 * asked about — `reconcileOrder` refuses a report whose `asOf` predates the
 * order's `submittedAt`, because an authoritative absence in a read taken
 * before the dispatch means only "not sent yet" and would otherwise lift the
 * resubmission guard on evidence about nothing.
 */
export async function reconcileAttempt(runtime: ExecutionRuntime, request: ReconcileRequest): Promise<SettleResult> {
  const report = runtime.exchange.readVenueState({ now: request.now });
  const resolved = runtime.exchange.reconcileOrder({ order: request.order, report, now: request.now });

  if (resolved.outcome === "REFUSED") {
    return refused(fromAdapterRefusal(resolved.refusal));
  }
  if (resolved.outcome === "UNRESOLVED") {
    // Still unconfirmed, and deliberately left that way: an order the read
    // could not settle stays exactly where it is rather than being resolved
    // by silence (`docs/resilience.md` §1, §3).
    return refused(fromAdapterRefusal(resolved.refusal));
  }

  return recordSettlement(
    runtime,
    { ...request, order: resolved.order },
    { reconciliationId: request.reconciliationId, reconciledAt: request.now },
  );
}

type ReconciliationEvidence = { readonly reconciliationId: string; readonly reconciledAt: string };

/**
 * Records the venue's confirmed position on one attempt, and — when that
 * position is final — journals it.
 */
async function recordSettlement(
  runtime: ExecutionRuntime,
  request: SettleRequest,
  reconciliation: ReconciliationEvidence | null,
): Promise<SettleResult> {
  const { db } = runtime;
  const intent = await loadApprovedIntent(db, request.intentId);
  if (intent === null) {
    return refused(
      executionRefusal("UNKNOWN_INTENT", `intent ${request.intentId} is not in durable history; nothing to settle against`),
    );
  }

  const side = sideFor(intent, request.instrument);
  if (side === null) {
    return refused(
      executionRefusal(
        "QUOTE_INSTRUMENT_MISMATCH",
        `intent ${request.intentId} does not trade ${request.instrument.baseAssetId}/${request.instrument.quoteAssetId} in either direction`,
      ),
    );
  }

  const settlement = settlementOf(request.order);
  const amounts = confirmedAmounts(settlement, intent, side);
  if (amounts === null) {
    return refused(
      executionRefusal(
        "VENUE_PRECISION_EXCEEDED",
        `the venue reported a fill for intent ${request.intentId} at a precision the authorization's own asset scales cannot hold`,
      ),
    );
  }

  const attemptState = attemptStateFor(request.order.state);
  const written = await recordAttemptOutcome(db, {
    intentId: request.intentId,
    attempt: request.attempt,
    state: attemptState,
    spentBase: amounts.spentBase,
    receivedBase: amounts.receivedBase,
    venueOrderId: request.order.venueOrderId,
    stateChangedAt: request.now,
    recordedAt: request.now,
    reconciliation,
  });
  if (written.outcome === "refused") {
    return refused(
      executionRefusal(
        "PERSISTENCE_REFUSED",
        `the outcome of attempt ${String(request.attempt)} on intent ${request.intentId} could not be recorded (${written.code}): ${written.detail}`,
      ),
    );
  }

  const overspend =
    amounts.spentBase > intent.input.maxSpendBase
      ? executionRefusal(
          "OVERSPEND_CONFIRMED",
          `attempt ${String(request.attempt)} on intent ${request.intentId} confirms ${amounts.spentBase.toString()} base units spent against an authorized ceiling of ${intent.input.maxSpendBase.toString()}; the spend has already happened and is recorded, not refused`,
        )
      : null;

  const journaled = await journalSettlement(db, {
    intent,
    settlement,
    amounts,
    attempt: request.attempt,
    now: request.now,
    ids: request.ids,
  });
  if (journaled.outcome === "refused") {
    return refused(journaled.refusal);
  }

  return {
    outcome: "recorded",
    order: request.order,
    attemptState,
    settlement,
    spentBase: amounts.spentBase,
    receivedBase: amounts.receivedBase,
    releasedBase: journaled.releasedBase,
    journaledEntryIds: journaled.entryIds,
    overspend,
  };
}

type ConfirmedAmounts = {
  readonly spentBase: bigint;
  readonly receivedBase: bigint;
  /** Gross at the execution price; already contains every embedded cost. */
  readonly grossNotionalBase: bigint;
  /** The fee and the fixed cost, which sit on top of the notional. */
  readonly separatelyChargedBase: bigint;
  readonly filledQuantityBase: bigint;
};

/**
 * The venue's figures, in the authorization's own base units.
 *
 * `netCapitalConsumed` is what leaves the funding side, and it is
 * `grossNotional + separatelyChargedCost` — the gross is already at the
 * execution price, so the spread and the slippage inside it are never added
 * a second time. Reconstructing the spend from gross plus *every* cost is
 * exactly the double count the embedded/separately-charged split exists to
 * prevent, so this reads the venue's own net rather than re-deriving one.
 */
function confirmedAmounts(
  settlement: OrderSettlement,
  intent: StoreApprovedIntent,
  side: "BUY" | "SELL",
): ConfirmedAmounts | null {
  const economics = settlement.economics;
  const quoteScale = side === "BUY" ? intent.input.scale : intent.output.scale;
  const baseScale = side === "BUY" ? intent.output.scale : intent.input.scale;

  const grossNotionalBase = unitsAt(economics.grossNotional, quoteScale);
  const separatelyChargedBase = unitsAt(economics.separatelyChargedCost, quoteScale);
  const filledQuantityBase = unitsAt(economics.filledQuantity, baseScale);
  const netQuote = side === "BUY" ? economics.netCapitalConsumed : economics.netProceeds;
  const netQuoteBase = netQuote === null ? null : unitsAt(netQuote, quoteScale);

  if (
    grossNotionalBase === null ||
    separatelyChargedBase === null ||
    filledQuantityBase === null ||
    netQuoteBase === null
  ) {
    return null;
  }

  return {
    spentBase: side === "BUY" ? netQuoteBase : filledQuantityBase,
    receivedBase: side === "BUY" ? filledQuantityBase : netQuoteBase,
    grossNotionalBase,
    separatelyChargedBase,
    filledQuantityBase,
  };
}

type JournalInput = {
  readonly intent: StoreApprovedIntent;
  readonly settlement: OrderSettlement;
  readonly amounts: ConfirmedAmounts;
  readonly attempt: number;
  readonly now: IsoUtcTimestamp;
  readonly ids: SettlementIdentities;
};

type JournalOutcome =
  | { readonly outcome: "posted"; readonly entryIds: readonly string[]; readonly releasedBase: bigint | null }
  | { readonly outcome: "refused"; readonly refusal: ExecutionRefusal };

/**
 * Posts the settled movement: the trade, the costs charged on top of it,
 * and — only under the condition the module header sets out — the release of
 * what was held and not spent.
 */
async function journalSettlement(db: VigilDatabase, input: JournalInput): Promise<JournalOutcome> {
  const { intent, settlement, amounts, attempt, now, ids } = input;

  // Nothing is posted until the venue has settled the outcome. A live or
  // unresolved order's exposure lives on the attempt row until then.
  if (!settlement.settled || amounts.filledQuantityBase === 0n) {
    return { outcome: "posted", entryIds: [], releasedBase: null };
  }

  const inputAsset = intent.input.assetId as AssetId;
  const outputAsset = intent.output.assetId as AssetId;
  const drafts: Array<{ readonly kind: EntryKind; readonly entryId: string; readonly lines: readonly StoreLine[] }> = [];

  drafts.push({
    kind: "trade",
    entryId: ids.tradeEntryId,
    lines: [
      line(inputAsset, intent.input.scale, "reserved", "credit", amounts.grossNotionalBase),
      exchangeLine(inputAsset, intent.input.scale, "debit", amounts.grossNotionalBase),
      line(outputAsset, intent.output.scale, "available", "debit", amounts.filledQuantityBase),
      exchangeLine(outputAsset, intent.output.scale, "credit", amounts.filledQuantityBase),
    ],
  });

  if (amounts.separatelyChargedBase > 0n) {
    drafts.push({
      kind: "fee",
      entryId: ids.feeEntryId,
      lines: [
        line(inputAsset, intent.input.scale, "reserved", "credit", amounts.separatelyChargedBase),
        {
          account: { family: "fees", assetId: inputAsset, holdingsState: null },
          scale: intent.input.scale,
          amountBase: amounts.separatelyChargedBase,
          direction: "debit",
        },
      ],
    });
  }

  // The hold was `max_spend_base`; the confirmed spend is what actually left.
  // Releasing the difference is safe only because a terminal attempt that
  // spent something has consumed the intent, so no retry can need it.
  const releasableBase = intent.input.maxSpendBase - amounts.spentBase;
  const releasedBase = releasableBase > 0n ? releasableBase : null;
  if (releasedBase !== null) {
    drafts.push({
      kind: "reservation-release",
      entryId: ids.releaseEntryId,
      lines: [
        line(inputAsset, intent.input.scale, "available", "debit", releasedBase),
        line(inputAsset, intent.input.scale, "reserved", "credit", releasedBase),
      ],
    });
  }

  const entryIds: string[] = [];
  for (const draft of drafts) {
    const entry: StoreEntry = {
      entryId: draft.entryId,
      kind: draft.kind,
      occurredAt: now,
      recordedAt: now,
      correlationId: intent.correlationId,
      idempotencyKey: `${draft.kind}:${intent.intentId}:a${String(attempt)}`,
      intentId: intent.intentId,
      reversesEntryId: null,
      provenance: {
        policyVersion: intent.provenance.policyVersion,
        strategyVersion: intent.provenance.strategyVersion,
        modelVersion: intent.provenance.modelVersion,
        portfolioSnapshotVersion: intent.provenance.portfolioSnapshotVersion,
        marketSnapshotVersion: intent.provenance.marketSnapshotVersion,
      },
      lines: draft.lines,
    };

    // `@vigil/ledger` owns what a valid posting is — balance per asset, the
    // families each kind may touch, and the fixed direction of a reservation
    // move. Checking here means a malformed entry is a reason code rather
    // than a constraint violation surfacing from inside a transaction.
    const validated = buildEntry(toLedgerEntry(entry, now));
    if (validated.outcome === "refused") {
      return {
        outcome: "refused",
        refusal: executionRefusal(
          "PERSISTENCE_REFUSED",
          `the ${draft.kind} posting for intent ${intent.intentId} is not a valid journal entry (${validated.refusal.reason.code}): ${validated.refusal.detail}`,
        ),
      };
    }

    const posted = await postJournalEntry(db, entry);
    if (posted.outcome === "refused") {
      return {
        outcome: "refused",
        refusal: executionRefusal(
          "PERSISTENCE_REFUSED",
          `the ${draft.kind} posting for intent ${intent.intentId} could not be written (${posted.code}): ${posted.detail}`,
        ),
      };
    }
    entryIds.push(posted.entryId);
  }

  return { outcome: "posted", entryIds, releasedBase };
}

function line(
  assetId: AssetId,
  scale: number,
  holdingsState: "available" | "reserved",
  direction: "debit" | "credit",
  amountBase: bigint,
): StoreLine {
  return {
    account: { family: "holdings", assetId, holdingsState },
    scale,
    amountBase,
    direction,
  };
}

function exchangeLine(assetId: AssetId, scale: number, direction: "debit" | "credit", amountBase: bigint): StoreLine {
  return {
    account: { family: "exchange", assetId, holdingsState: null },
    scale,
    amountBase,
    direction,
  };
}

/**
 * The same entry in `@vigil/ledger`'s shape, so its validation can run before
 * anything is written. The two types are structurally the same record with
 * different timestamp types — `StoreEntry` carries ISO strings for the
 * database, `JournalEntry` the branded instants — and neither package may
 * import the other to say so.
 */
function toLedgerEntry(entry: StoreEntry, now: IsoUtcTimestamp): JournalEntry {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    occurredAt: now,
    recordedAt: now,
    correlationId: entry.correlationId,
    idempotencyKey: entry.idempotencyKey,
    intentId: entry.intentId,
    reversesEntryId: entry.reversesEntryId,
    provenance: entry.provenance,
    lines: entry.lines.map((storeLine) => ({
      account: {
        family: storeLine.account.family,
        assetId: storeLine.account.assetId as AssetId,
        holdingsState: storeLine.account.holdingsState,
      },
      scale: storeLine.scale,
      amountBase: storeLine.amountBase,
      direction: storeLine.direction,
    })),
  };
}
