import { decimalStringSchema } from "@vigil/contracts";
import type { DecimalString } from "@vigil/contracts";
import type { OrderSide } from "@vigil/adapter-paper";
import { fromBaseUnits, toBaseUnits } from "@vigil/ledger";
import type { QuoteSnapshot } from "@vigil/market";
import type { NetEdgeCosts } from "@vigil/policy";

import type { VenueExecutionConfig } from "./venue";

/**
 * venue-economics.ts — what this venue will actually charge for a given
 * quantity at a given quote, and the translation of that cost model into
 * the one `@vigil/policy` consumes.
 *
 * ## Why this file exists at all
 *
 * `@vigil/adapter-paper` computes the same numbers, and exports none of the
 * functions that do it (`execution-economics.ts` is reachable only through
 * `settlementOf`, which needs an order that has already been submitted).
 * That is not an oversight to work around: `maxSpend` is **vigil's own**
 * ceiling on an authorization, derived from vigil's own fee snapshot, and an
 * application that asked the venue what it was about to be charged and then
 * wrote that down as its limit would have no limit at all. The adapter
 * checks its worst case against this ceiling and refuses when it does not
 * fit (`MAX_SPEND_EXCEEDED`); two independent computations that must agree
 * is the point.
 *
 * The cost of two computations is that they can drift. `venue-economics.test.ts`
 * is the guard: it drives a real `createPaperExchange` at the same
 * configuration and asserts the settled `netCapitalConsumed` of a complete
 * fill equals `envelopeFor(...).maxSpendUnits` to the unit. A divergence
 * fails there rather than as an authorization that can never be dispatched.
 *
 * ## Where each cost sits, and why the grouping is not the adapter's
 *
 * `@vigil/adapter-paper` marks SPREAD and SLIPPAGE `EMBEDDED_IN_PRICE` and
 * VENUE_FEE and FIXED_COST `SEPARATELY_CHARGED`, measured against its
 * `executionPrice`. `@vigil/policy`'s `NetEdgeCosts` groups by the same
 * property — "already inside the price you handed me" versus "charged on top
 * of it" — but the price it is handed is whatever the caller passes as
 * `executablePrice`, so the grouping is a statement about *that* price, not
 * a universal property of a cost. `costs.ts`'s prose picks the ask as that
 * price and therefore calls slippage separately charged.
 *
 * **This application hands policy the venue's `executionPrice`**, and the
 * grouping follows from that choice:
 *
 * | Cost | Inside `executionPrice`? | policy group |
 * | --- | --- | --- |
 * | spread (`referencePrice` − `referenceMid`) | yes | `embedded` |
 * | slippage (`executionPrice` − `referencePrice`) | yes | `embedded` |
 * | proportional venue fee | no | `separatelyCharged` |
 * | fixed execution cost | no | `separatelyCharged` |
 *
 * Handing policy the ask instead — the other self-consistent wiring — puts
 * slippage in `separatelyCharged` and is wrong here by a small, real amount:
 * this venue charges its fee on the notional at `executionPrice`, while
 * `checkNetEdge` and `sizeTrade` would apply the rate to a notional at the
 * ask. The fee on the slippage component would go uncharged, so net edge
 * would be overstated and the capital bound would permit a quantity whose
 * actual cash out exceeds the funds available.
 *
 * Passing `executionPrice` lines `sizeTrade`'s closed form up with what the
 * venue charges. It is an **inequality, not an identity**, and the direction
 * is worth stating plainly:
 *
 * ```text
 *   policy models   q*p*(1 + r)                     + fixed
 *   the venue bills ceil(q*p) + ceil(ceil(q*p) * r) + fixed
 * ```
 *
 * Two ceilings, so the venue's figure is greater than or equal to policy's,
 * by at most about two money units. Sizing therefore models very slightly
 * LESS cash out than the venue will charge — the permissive direction — and
 * what keeps that harmless is not this file but `reserveAvailable`, which
 * re-reads the balance under `SELECT … FOR UPDATE` and refuses
 * `INSUFFICIENT_AVAILABLE` before any attempt is opened. A sized quantity
 * the funds do not quite cover fails there, leaving nothing behind.
 *
 * The over-permission is real rather than absorbed, and it is stated here so
 * it is not mistaken for a guarantee. In cash it is bounded by those ~2
 * money units whatever the instrument; in quantity it is that cash divided
 * by the per-unit cost, so a cheaper instrument at the same two scales turns
 * the same 2 units of cash into a larger quantity. Either way the excess is
 * caught in exactly one place — a refused reservation — and never reaches a
 * venue, because the reservation is taken before the attempt is opened and a
 * refusal there leaves nothing behind.
 *
 * Both embedded components therefore sum into policy's single
 * `embedded.spreadCostPerUnitQuote` field. They stay separately visible in
 * `VenuePricingView` and in the intent's `intent_cost_components` rows,
 * which carry the **venue's** charge basis (`embedded` for both), so the
 * durable record says what the venue did and the policy call says what the
 * price handed to policy contained. The two agree here; they would not have
 * under the other wiring.
 *
 * Nothing in this file counts a cost twice: `embedded` reduces net edge and
 * is excluded from every sizing bound (`costs.ts`), and `netCapitalConsumed`
 * is `grossNotional + separatelyChargedCost` — the gross is already at
 * `executionPrice`, so the embedded components are never added to it again.
 *
 * ## Arithmetic
 *
 * Exact integers throughout. Decimal strings convert through
 * `@vigil/ledger`'s `toBaseUnits`/`fromBaseUnits` — the workspace's only
 * exported decimal/base-unit conversion — and every division rounds in the
 * direction that cannot flatter vigil: a buyer's notional and every fee up,
 * a seller's proceeds down. `Number()`, `parseFloat`, `parseInt`, `toFixed`
 * and unary `+` appear on no money value here.
 */

const BASIS_POINT_DIVISOR = 10_000n;

/** Fee rates are rendered at four decimals, which holds any whole basis-point rate exactly. */
const BASIS_POINT_SCALE = 4;

export const ZERO_DECIMAL: DecimalString = decimalStringSchema.parse("0");

/** Rounding direction for a division that does not divide evenly. */
export type Rounding = "UP" | "DOWN";

/**
 * `(factor * multiplicand) / divisor` over non-negative magnitudes, rounded
 * as the call site names. The product is formed before the division so no
 * intermediate precision is lost.
 *
 * A non-positive divisor or a negative operand is a programmer error rather
 * than schema-legal input — every price, quantity, and rate reaching here has
 * already been validated — so it throws (`docs/resilience.md` §4 reserves an
 * exception for exactly that).
 */
export function scaledProduct(
  factor: bigint,
  multiplicand: bigint,
  divisor: bigint,
  rounding: Rounding,
): bigint {
  if (divisor <= 0n) {
    throw new Error(`scaledProduct: divisor must be positive, got ${divisor.toString()}`);
  }
  if (factor < 0n || multiplicand < 0n) {
    throw new Error(
      `scaledProduct: operands are magnitudes and must be non-negative, got ${factor.toString()} and ${multiplicand.toString()}`,
    );
  }
  const product = factor * multiplicand;
  const remainder = product % divisor;
  const quotient = product / divisor;
  return rounding === "UP" && remainder > 0n ? quotient + 1n : quotient;
}

/** `10 ** scale`. The scale is always an internal, already-validated constant. */
export function scaleFactor(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) {
    throw new Error(`scaleFactor: scale must be a whole number in 0..36, got ${String(scale)}`);
  }
  return 10n ** BigInt(scale);
}

/**
 * `value` as an exact count of units at `scale`, or `null` when it carries
 * finer precision than the scale holds. `null` is never zero and never
 * "close enough" — a caller turns it into a reason-coded refusal.
 */
export function unitsAt(value: DecimalString, scale: number): bigint | null {
  const converted = toBaseUnits(value, scale);
  return converted.outcome === "ok" ? converted.base : null;
}

/**
 * The inverse. A magnitude this module produced is in range by construction,
 * so a refusal here is a programmer error rather than input this application
 * could have been handed.
 */
export function decimalAt(units: bigint, scale: number): DecimalString {
  const rendered = fromBaseUnits(units, scale);
  if (rendered.outcome === "refused") {
    throw new Error(`decimalAt: ${units.toString()} at scale ${String(scale)} — ${rendered.refusal.detail}`);
  }
  return rendered.amount;
}

/**
 * Everything this venue fixes about an order's economics from one quote: the
 * prices, and the per-unit costs standing between the midpoint and what will
 * actually be paid.
 *
 * Derived identically to `@vigil/adapter-paper`'s `derivePricing`, including
 * the per-side midpoint rounding — down for a buy (whose spread is
 * `ask - mid`), up for a sell (whose spread is `mid - bid`) — which is what
 * keeps both the spread and the slippage component non-negative.
 */
export type VenuePricingView = {
  readonly side: OrderSide;
  readonly moneyScale: number;
  readonly quantityScale: number;
  readonly referenceBid: DecimalString;
  readonly referenceAsk: DecimalString;
  readonly referenceMid: DecimalString;
  /** The executable side this order trades against: the ask for a buy, the bid for a sell. */
  readonly referencePrice: DecimalString;
  /** The reference side moved adversely by the configured slippage cap. Every fill lands here. */
  readonly executionPrice: DecimalString;
  /** `|referencePrice - referenceMid|`, per unit of base asset. Inside `executionPrice`. */
  readonly spreadPerUnitQuote: DecimalString;
  /** `|executionPrice - referencePrice|`, per unit of base asset. Also inside `executionPrice`. */
  readonly slippagePerUnitQuote: DecimalString;
  /** Their sum: everything `executionPrice` already contains, per unit. */
  readonly embeddedPerUnitQuote: DecimalString;
  /** The venue fee as a fraction of the notional at `executionPrice`. */
  readonly proportionalFeeRate: DecimalString;
  readonly fixedCostsQuote: DecimalString;
  readonly units: {
    readonly referenceMid: bigint;
    readonly referencePrice: bigint;
    readonly executionPrice: bigint;
    readonly spreadPerUnit: bigint;
    readonly slippagePerUnit: bigint;
    readonly fixedCosts: bigint;
  };
};

export type PricingFailure =
  | { readonly reason: "VENUE_PRECISION_EXCEEDED"; readonly detail: string }
  | { readonly reason: "CROSSED_QUOTE_BOOK"; readonly detail: string };

export type PricingResult =
  | { readonly outcome: "priced"; readonly pricing: VenuePricingView }
  | { readonly outcome: "unpriceable"; readonly failure: PricingFailure };

/**
 * Fixes an order's economics from a parsed quote. Never throws on a quote
 * that parsed: both ways it can fail — precision the venue cannot hold, and
 * a crossed book — come back as a named failure the caller turns into a
 * reason code (`docs/resilience.md` §4).
 */
export function priceExecutable(
  side: OrderSide,
  quote: QuoteSnapshot,
  venue: VenueExecutionConfig,
): PricingResult {
  const bidUnits = unitsAt(quote.bidPrice, venue.moneyScale);
  const askUnits = unitsAt(quote.askPrice, venue.moneyScale);
  if (bidUnits === null || askUnits === null) {
    return {
      outcome: "unpriceable",
      failure: {
        reason: "VENUE_PRECISION_EXCEEDED",
        detail: `quoted prices ("${quote.bidPrice}" / "${quote.askPrice}") carry finer precision than the venue's money scale (${String(venue.moneyScale)})`,
      },
    };
  }

  if (askUnits < bidUnits) {
    return {
      outcome: "unpriceable",
      failure: {
        reason: "CROSSED_QUOTE_BOOK",
        detail: `the quote's ask (${quote.askPrice}) is below its bid (${quote.bidPrice}); a crossed book is corrupt market state and blocks new risk (docs/resilience.md §1)`,
      },
    };
  }

  const buying = side === "BUY";
  const referenceUnits = buying ? askUnits : bidUnits;
  const midUnits = buying ? (bidUnits + askUnits) / 2n : (bidUnits + askUnits + 1n) / 2n;
  const slippage = BigInt(venue.slippageBasisPoints);
  const executionUnits = buying
    ? scaledProduct(referenceUnits, BASIS_POINT_DIVISOR + slippage, BASIS_POINT_DIVISOR, "UP")
    : scaledProduct(referenceUnits, BASIS_POINT_DIVISOR - slippage, BASIS_POINT_DIVISOR, "DOWN");

  const spreadUnits = buying ? referenceUnits - midUnits : midUnits - referenceUnits;
  const slippageUnits = buying ? executionUnits - referenceUnits : referenceUnits - executionUnits;
  const fixedUnits = unitsAt(venue.fixedExecutionCostQuote, venue.moneyScale);
  if (fixedUnits === null) {
    return {
      outcome: "unpriceable",
      failure: {
        reason: "VENUE_PRECISION_EXCEEDED",
        detail: `the venue's fixed execution cost ("${venue.fixedExecutionCostQuote}") carries finer precision than its own money scale (${String(venue.moneyScale)})`,
      },
    };
  }

  return {
    outcome: "priced",
    pricing: {
      side,
      moneyScale: venue.moneyScale,
      quantityScale: venue.quantityScale,
      referenceBid: quote.bidPrice,
      referenceAsk: quote.askPrice,
      referenceMid: decimalAt(midUnits, venue.moneyScale),
      referencePrice: decimalAt(referenceUnits, venue.moneyScale),
      executionPrice: decimalAt(executionUnits, venue.moneyScale),
      spreadPerUnitQuote: decimalAt(spreadUnits, venue.moneyScale),
      slippagePerUnitQuote: decimalAt(slippageUnits, venue.moneyScale),
      embeddedPerUnitQuote: decimalAt(spreadUnits + slippageUnits, venue.moneyScale),
      proportionalFeeRate: decimalAt(BigInt(venue.feeBasisPoints), BASIS_POINT_SCALE),
      fixedCostsQuote: venue.fixedExecutionCostQuote,
      units: {
        referenceMid: midUnits,
        referencePrice: referenceUnits,
        executionPrice: executionUnits,
        spreadPerUnit: spreadUnits,
        slippagePerUnit: slippageUnits,
        fixedCosts: fixedUnits,
      },
    },
  };
}

/**
 * The cost model `@vigil/policy` consumes, translated from this venue's.
 *
 * `separatelyCharged.slippageAllowancePerUnitQuote` is deliberately zero:
 * this venue's slippage cap is inside `executionPrice`, which is the price
 * handed to policy, so charging it again on top of the notional would deduct
 * it twice — once through the price and once through the bound. See this
 * module's header for the full table and for why the other wiring
 * under-bounds the fee.
 */
export function netEdgeCostsFor(pricing: VenuePricingView): NetEdgeCosts {
  return {
    embedded: { spreadCostPerUnitQuote: pricing.embeddedPerUnitQuote },
    separatelyCharged: {
      proportionalFeeRate: pricing.proportionalFeeRate,
      slippageAllowancePerUnitQuote: ZERO_DECIMAL,
      fixedCostsQuote: pricing.fixedCostsQuote,
    },
  };
}

/**
 * The economics of filling the WHOLE quantity: a genuine bound, not an
 * estimate, because every execution fills at `executionPrice` and the venue
 * computes every total on the cumulative quantity
 * (`@vigil/adapter-paper`'s `execution-economics.ts`, invariant 1). Any
 * partial fill consumes strictly less than `maxSpendUnits`; a complete fill
 * consumes exactly it, whatever pattern of executions delivered it.
 */
export type ExecutionEnvelope = {
  readonly quantityUnits: bigint;
  /** Gross at `executionPrice`, already containing both embedded components. */
  readonly notionalUnits: bigint;
  readonly feeUnits: bigint;
  readonly fixedUnits: bigint;
  /** Everything embedded in `notionalUnits`, reported so it is visible and never re-added. */
  readonly embeddedUnits: bigint;
  /** Buy: the most quote asset a complete fill can consume. */
  readonly maxSpendUnits: bigint;
  /** Sell: the least quote asset a complete fill can deliver. Floored at zero. */
  readonly minReceiptUnits: bigint;
};

export function envelopeFor(pricing: VenuePricingView, quantityUnits: bigint): ExecutionEnvelope {
  const buying = pricing.side === "BUY";
  const notionalUnits = scaledProduct(
    quantityUnits,
    pricing.units.executionPrice,
    scaleFactor(pricing.quantityScale),
    buying ? "UP" : "DOWN",
  );
  const feeUnits = scaledProduct(notionalUnits, feeBasisPointsOf(pricing), BASIS_POINT_DIVISOR, "UP");
  const fixedUnits = pricing.units.fixedCosts;
  const embeddedUnits = scaledProduct(
    quantityUnits,
    pricing.units.spreadPerUnit + pricing.units.slippagePerUnit,
    scaleFactor(pricing.quantityScale),
    buying ? "UP" : "DOWN",
  );
  const receipt = notionalUnits - feeUnits - fixedUnits;

  return {
    quantityUnits,
    notionalUnits,
    feeUnits,
    fixedUnits,
    embeddedUnits,
    maxSpendUnits: notionalUnits + feeUnits + fixedUnits,
    // A floor of zero rather than a negative "receipt": a trade whose costs
    // exceed its proceeds delivers nothing, and a negative minimum would be
    // a floor every fill clears.
    minReceiptUnits: receipt < 0n ? 0n : receipt,
  };
}

/**
 * The whole-basis-point rate back out of the rendered decimal. Rendering and
 * re-reading rather than carrying the integer twice keeps one source of
 * truth for the rate on both sides of the policy call.
 */
function feeBasisPointsOf(pricing: VenuePricingView): bigint {
  const units = unitsAt(pricing.proportionalFeeRate, BASIS_POINT_SCALE);
  if (units === null) {
    throw new Error(`venue economics: fee rate "${pricing.proportionalFeeRate}" is not a whole basis-point rate`);
  }
  return units;
}
