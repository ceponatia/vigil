import type { DecimalString } from "@vigil/contracts";

import type { OrderSide } from "./intent";
import { fractionalDigits, mulDiv, renderUnits, scaleFactor, unitsOf } from "./venue-math";

/**
 * execution-economics.ts — the pure arithmetic of what a fill actually costs.
 *
 * `docs/product.md` measures success after costs and `docs/evaluation.md`
 * rejects OHLC-only assumptions, so an adapter that reported only a price and
 * a fee would let a favourable move look profitable while the spread and the
 * fee ate it. Issue #33 therefore asks for a breakdown a caller can use to
 * tell nominal price movement from executable economics, and this module is
 * where every number in it is computed.
 *
 * ## Two invariants everything here exists to hold
 *
 * **1. Totals are computed on the cumulative quantity, never summed from
 * independently rounded executions.** This is not a style preference; the
 * previous revision was wrong because of it. Each fee and notional rounds in
 * the direction that cannot flatter vigil, so rounding each execution
 * independently makes the total strictly larger than the same quantity filled
 * at once: `Σ ceil(qᵢ·p/F) ≥ ceil((Σqᵢ)·p/F)`. A submission check that proved
 * the whole order fits `maxSpend` therefore proved nothing about a fill
 * delivered in steps. With this package's own fixture (money scale 2,
 * quantity scale 4, 25bp fee, ask 250.10), a quantity of `0.0003` approved at
 * a ceiling of `0.09` spends `0.12` when filled as three executions of
 * `0.0001` — 33% over an approved envelope.
 *
 * `cumulativeNotionalUnits`/`cumulativeFeeUnits` below take the RUNNING TOTAL
 * quantity, and `exchange.ts` derives each execution as the difference between
 * the new cumulative figure and the previous one. The per-execution numbers
 * are then exact increments of an exact total, the totals are identical to the
 * whole-order figures whatever the step pattern, and the submission check
 * becomes the proof it claims to be. A consequence worth knowing when reading
 * a fill: two executions of the same quantity can carry different notionals,
 * and an execution can carry a zero fee, because each reports its own
 * increment rather than a rounding of itself.
 *
 * **2. A cost is reported once, in the place it was actually charged.**
 * Spread and slippage are EMBEDDED_IN_PRICE: they exist because the fill used
 * the executable side of the book, moved by the slippage cap, rather than the
 * midpoint — so they are already inside `grossNotional` and must never be
 * subtracted from it again. The venue fee and the fixture's fixed cost are
 * SEPARATELY_CHARGED: they sit on top of the notional. Every component says
 * which it is, so `packages/policy`'s net-edge check (issue #32) can consume
 * the breakdown without double-charging what the price already contains.
 *
 * The decomposition is exact by construction, because each cost is defined as
 * the DIFFERENCE between two notionals computed the same way rather than as an
 * independently rounded product. For a buy,
 * `netCapitalConsumed == grossAtReferenceMid + totalIncrementalCost`; for a
 * sell, `netProceeds == grossAtReferenceMid - totalIncrementalCost`. Those two
 * identities hold to the unit for every fixture and are the machine-checkable
 * form of "counted once".
 */

/** The four costs this adapter can attribute. Aligned with `packages/policy`'s net-edge cost model. */
export const COST_COMPONENTS = ["SPREAD", "SLIPPAGE", "VENUE_FEE", "FIXED_COST"] as const;

export type CostComponent = (typeof COST_COMPONENTS)[number];

export const COST_CHARGINGS = ["EMBEDDED_IN_PRICE", "SEPARATELY_CHARGED"] as const;

export type CostCharging = (typeof COST_CHARGINGS)[number];

/**
 * Where each component was charged. This mapping IS the no-double-charge
 * contract: an `EMBEDDED_IN_PRICE` amount is already inside `grossNotional`
 * and is reported so a caller can see it, never so a caller can deduct it.
 */
export const COST_COMPONENT_CHARGING: Readonly<Record<CostComponent, CostCharging>> = {
  SPREAD: "EMBEDDED_IN_PRICE",
  SLIPPAGE: "EMBEDDED_IN_PRICE",
  VENUE_FEE: "SEPARATELY_CHARGED",
  FIXED_COST: "SEPARATELY_CHARGED",
};

export type ExecutionCost = {
  readonly component: CostComponent;
  readonly charging: CostCharging;
  /** Always non-negative, in the quote asset, at the venue's money scale. */
  readonly amount: DecimalString;
};

/**
 * Everything the venue fixed about this order's economics at the moment it
 * was submitted, stamped onto the order so the breakdown can be recomputed
 * from the order alone — no exchange instance, no clock, no quote.
 */
export type VenuePricing = {
  readonly moneyScale: number;
  readonly quantityScale: number;
  readonly feeBasisPoints: number;
  readonly slippageBasisPoints: number;
  /** The top of book the simulation priced from. */
  readonly referenceBid: DecimalString;
  readonly referenceAsk: DecimalString;
  /**
   * The midpoint, rounded in the direction that never understates this
   * order's measured spread cost — down for a buy (whose spread is
   * `ask - mid`), up for a sell (whose spread is `mid - bid`).
   */
  readonly referenceMid: DecimalString;
  /** The executable side this order trades against: the ask for a buy, the bid for a sell. */
  readonly referencePrice: DecimalString;
  /** Every execution fills here: the reference side moved adversely by the slippage cap. */
  readonly executionPrice: DecimalString;
  /** A flat cost the fixture charges once, and only when the order actually produced a fill. */
  readonly fixedExecutionCost: DecimalString;
};

export type ExecutionEconomics = {
  readonly requestedQuantity: DecimalString;
  readonly filledQuantity: DecimalString;
  readonly unfilledQuantity: DecimalString;
  readonly referenceBid: DecimalString | null;
  readonly referenceAsk: DecimalString | null;
  readonly referenceMid: DecimalString | null;
  readonly referencePrice: DecimalString | null;
  readonly executionPrice: DecimalString | null;
  /** What the filled quantity would have cost (buy) or yielded (sell) at the midpoint, with no cost at all. */
  readonly grossAtReferenceMid: DecimalString;
  /** Gross at the execution price. Already contains every `EMBEDDED_IN_PRICE` component. */
  readonly grossNotional: DecimalString;
  readonly costs: readonly ExecutionCost[];
  /** Sum of the embedded components. Informational: already inside `grossNotional`. */
  readonly embeddedCost: DecimalString;
  /** Sum of the separately charged components. Added to a buy's spend, deducted from a sell's proceeds. */
  readonly separatelyChargedCost: DecimalString;
  readonly totalIncrementalCost: DecimalString;
  /** Positive quote-asset amount spent. `null` for a sell. */
  readonly netCapitalConsumed: DecimalString | null;
  /** Positive quote-asset amount received. `null` for a buy. */
  readonly netProceeds: DecimalString | null;
  /** Signed, and what the ledger posts: negative for a buy, positive for a sell. */
  readonly netCashFlow: DecimalString;
};

function requiredUnits(value: DecimalString, scale: number, field: string): bigint {
  const units = unitsOf(value, scale);
  if (units === null) {
    // Unreachable: every value reaching here was either rendered at this
    // scale by this package or validated against it at submission.
    throw new Error(`execution economics: ${field} ("${value}") does not fit the venue's own scale ${String(scale)}`);
  }
  return units;
}

/**
 * The notional for `quantityUnits` at `priceUnits`, rounded the way that
 * cannot flatter vigil: up for a buy (it pays more), down for a sell (it
 * receives less).
 */
export function notionalUnitsAt(
  priceUnits: bigint,
  quantityUnits: bigint,
  quantityScale: number,
  side: OrderSide,
): bigint {
  return mulDiv(quantityUnits, priceUnits, scaleFactor(quantityScale), side === "BUY" ? "UP" : "DOWN");
}

/** The notional for a RUNNING TOTAL quantity at the execution price. See invariant 1 above. */
export function cumulativeNotionalUnits(pricing: VenuePricing, side: OrderSide, quantityUnits: bigint): bigint {
  const priceUnits = requiredUnits(pricing.executionPrice, pricing.moneyScale, "executionPrice");
  return notionalUnitsAt(priceUnits, quantityUnits, pricing.quantityScale, side);
}

/** The fee on a RUNNING TOTAL notional, always rounded up. See invariant 1 above. */
export function cumulativeFeeUnits(pricing: VenuePricing, notionalUnits: bigint): bigint {
  return mulDiv(notionalUnits, BigInt(pricing.feeBasisPoints), 10_000n, "UP");
}

export type WorstCaseEconomics = {
  readonly notionalUnits: bigint;
  readonly feeUnits: bigint;
  readonly fixedUnits: bigint;
  /** Buy: the most quote asset the order can consume. */
  readonly spendUnits: bigint;
  /** Sell: the least quote asset the order can deliver. */
  readonly receiptUnits: bigint;
};

/**
 * The economics of filling the WHOLE requested quantity. Because every
 * execution fills at `pricing.executionPrice` and every total is computed on
 * the cumulative quantity, this is a genuine bound: any partial fill consumes
 * strictly less than `spendUnits`, and a complete fill consumes exactly it,
 * whatever pattern of executions delivered it.
 *
 * `receiptUnits` bounds the proceeds of a COMPLETE fill. A partial fill
 * delivers proportionally less, which is not a breach of the approved
 * minimum but the ordinary meaning of a partial fill — the caller reads
 * `filledQuantity` alongside it.
 */
export function worstCaseEconomics(pricing: VenuePricing, side: OrderSide, quantityUnits: bigint): WorstCaseEconomics {
  const notionalUnits = cumulativeNotionalUnits(pricing, side, quantityUnits);
  const feeUnits = cumulativeFeeUnits(pricing, notionalUnits);
  const fixedUnits = requiredUnits(pricing.fixedExecutionCost, pricing.moneyScale, "fixedExecutionCost");
  return {
    notionalUnits,
    feeUnits,
    fixedUnits,
    spendUnits: notionalUnits + feeUnits + fixedUnits,
    receiptUnits: notionalUnits - feeUnits - fixedUnits,
  };
}

export type ExecutionEconomicsInput = {
  readonly pricing: VenuePricing | null;
  readonly side: OrderSide;
  readonly requestedQuantity: DecimalString;
  /** Sum of the executions' quantities, at `pricing.quantityScale`. */
  readonly filledUnits: bigint;
  /** Sum of the executions' notionals, at `pricing.moneyScale`. */
  readonly grossNotionalUnits: bigint;
  /** Sum of the executions' fees, at `pricing.moneyScale`. */
  readonly feeUnits: bigint;
};

/**
 * The full breakdown. Every cost is a difference between two notionals
 * computed identically, so the components add up to the net exactly rather
 * than approximately.
 *
 * An order that was never submitted has no pricing and therefore no
 * economics: zeros and nulls, not a guess.
 */
export function computeExecutionEconomics(input: ExecutionEconomicsInput): ExecutionEconomics {
  const { pricing, side, requestedQuantity, filledUnits, grossNotionalUnits, feeUnits } = input;

  if (pricing === null) {
    const quantityScale = fractionalDigits(requestedQuantity);
    const zero = renderUnits(0n, 0);
    return {
      requestedQuantity,
      filledQuantity: renderUnits(0n, quantityScale),
      unfilledQuantity: requestedQuantity,
      referenceBid: null,
      referenceAsk: null,
      referenceMid: null,
      referencePrice: null,
      executionPrice: null,
      grossAtReferenceMid: zero,
      grossNotional: zero,
      costs: [],
      embeddedCost: zero,
      separatelyChargedCost: zero,
      totalIncrementalCost: zero,
      netCapitalConsumed: side === "BUY" ? zero : null,
      netProceeds: side === "SELL" ? zero : null,
      netCashFlow: zero,
    };
  }

  const { moneyScale, quantityScale } = pricing;
  const midUnits = requiredUnits(pricing.referenceMid, moneyScale, "referenceMid");
  const referenceUnits = requiredUnits(pricing.referencePrice, moneyScale, "referencePrice");

  const midNotionalUnits = notionalUnitsAt(midUnits, filledUnits, quantityScale, side);
  const referenceNotionalUnits = notionalUnitsAt(referenceUnits, filledUnits, quantityScale, side);

  // Both differences are non-negative because the submission gate refuses a
  // crossed book (so the midpoint sits between bid and ask) and the slippage
  // cap only ever moves the price against the caller. A negative "cost" would
  // inflate net edge downstream, so neither is clamped — they cannot occur.
  const spreadUnits =
    side === "BUY" ? referenceNotionalUnits - midNotionalUnits : midNotionalUnits - referenceNotionalUnits;
  const slippageUnits =
    side === "BUY" ? grossNotionalUnits - referenceNotionalUnits : referenceNotionalUnits - grossNotionalUnits;

  const fixedUnits = filledUnits > 0n ? requiredUnits(pricing.fixedExecutionCost, moneyScale, "fixedExecutionCost") : 0n;

  const embeddedUnits = spreadUnits + slippageUnits;
  const separatelyChargedUnits = feeUnits + fixedUnits;
  const totalUnits = embeddedUnits + separatelyChargedUnits;

  const netUnits =
    side === "BUY" ? -(grossNotionalUnits + separatelyChargedUnits) : grossNotionalUnits - separatelyChargedUnits;

  const costs: readonly ExecutionCost[] = [
    { component: "SPREAD", charging: COST_COMPONENT_CHARGING.SPREAD, amount: renderUnits(spreadUnits, moneyScale) },
    { component: "SLIPPAGE", charging: COST_COMPONENT_CHARGING.SLIPPAGE, amount: renderUnits(slippageUnits, moneyScale) },
    { component: "VENUE_FEE", charging: COST_COMPONENT_CHARGING.VENUE_FEE, amount: renderUnits(feeUnits, moneyScale) },
    { component: "FIXED_COST", charging: COST_COMPONENT_CHARGING.FIXED_COST, amount: renderUnits(fixedUnits, moneyScale) },
  ];

  const requestedUnits = requiredUnits(requestedQuantity, quantityScale, "requestedQuantity");

  return {
    requestedQuantity,
    filledQuantity: renderUnits(filledUnits, quantityScale),
    unfilledQuantity: renderUnits(requestedUnits - filledUnits, quantityScale),
    referenceBid: pricing.referenceBid,
    referenceAsk: pricing.referenceAsk,
    referenceMid: pricing.referenceMid,
    referencePrice: pricing.referencePrice,
    executionPrice: pricing.executionPrice,
    grossAtReferenceMid: renderUnits(midNotionalUnits, moneyScale),
    grossNotional: renderUnits(grossNotionalUnits, moneyScale),
    costs,
    embeddedCost: renderUnits(embeddedUnits, moneyScale),
    separatelyChargedCost: renderUnits(separatelyChargedUnits, moneyScale),
    totalIncrementalCost: renderUnits(totalUnits, moneyScale),
    netCapitalConsumed: side === "BUY" ? renderUnits(grossNotionalUnits + separatelyChargedUnits, moneyScale) : null,
    netProceeds: side === "SELL" ? renderUnits(grossNotionalUnits - separatelyChargedUnits, moneyScale) : null,
    netCashFlow: renderUnits(netUnits, moneyScale),
  };
}
