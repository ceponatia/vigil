import { z } from "zod";
import { assetIdSchema, decimalStringSchema, isoUtcTimestampSchema } from "@vigil/contracts";
import type { DecimalString, IsoUtcTimestamp } from "@vigil/contracts";

/**
 * intent.ts — the trust boundary between whatever hands this adapter an
 * approved intent and the simulated venue behind it
 * (`docs/resilience.md` §5).
 *
 * `ApprovedEconomicIntent` (`docs/architecture.md` "Contracts") is a wider
 * record than an execution adapter needs, and an adapter that accepted the
 * whole thing would be claiming authority over fields it has no business
 * reading — the thesis, the evidence, the entry zone. This schema is the
 * execution-relevant subset, parsed here so that every value the venue
 * arithmetic touches has been validated exactly once, at the edge:
 *
 * - identity and provenance, carried onto every order and execution record
 *   so the caller can persist a complete economic record
 *   (`AGENTS.md` "Architecture and implementation");
 * - the economic envelope the approval actually authorized — `quantity`,
 *   `maxSpend`, `minAcceptableReceipt`, `permittedResidual` — which the
 *   adapter checks a submission against before the venue ever sees it;
 * - the validity window and freshness requirement, which decide whether
 *   this intent may be acted on at the supplied time and against the
 *   supplied quote.
 *
 * Asset identity is `assetIdSchema`, so an intent naming a ticker rather
 * than a canonical chain-aware asset id cannot reach the venue at all
 * (`AGENTS.md`: asset identity is chain plus contract, mint, or native
 * denomination plus withdrawal network — never a ticker alone).
 */

export const TRADE_ACTIONS = ["BUY", "ADD", "HOLD", "TRIM", "EXIT", "WAIT", "AVOID"] as const;

export type TradeAction = (typeof TRADE_ACTIONS)[number];

export const ORDER_SIDES = ["BUY", "SELL"] as const;

export const orderSideSchema = z.enum(ORDER_SIDES);

export type OrderSide = z.infer<typeof orderSideSchema>;

/**
 * Which side of the book each approved action executes on, or `null` where
 * the action authorizes no execution at all. `HOLD`, `WAIT`, and `AVOID`
 * are decisions to do nothing and must never be silently turned into an
 * order — the no-chasing rule in reverse (`AGENTS.md`: a missed entry is
 * WAIT or MISSED, never a rewritten BUY).
 */
export const ACTION_ORDER_SIDES: Readonly<Record<TradeAction, OrderSide | null>> = {
  BUY: "BUY",
  ADD: "BUY",
  TRIM: "SELL",
  EXIT: "SELL",
  HOLD: null,
  WAIT: null,
  AVOID: null,
};

export const approvedOrderIntentSchema = z.object({
  intentId: z.string().min(1),
  economicActionId: z.string().min(1),
  positionPlanId: z.string().min(1),
  /** Unique per economic action; the venue keys its own order book by this. */
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  venueId: z.string().min(1),
  action: z.enum(TRADE_ACTIONS),
  inputAssetId: assetIdSchema,
  outputAssetId: assetIdSchema,
  quantity: decimalStringSchema,
  maxSpend: decimalStringSchema,
  minAcceptableReceipt: decimalStringSchema,
  permittedResidual: decimalStringSchema,
  validUntil: isoUtcTimestampSchema,
  requiredFreshnessMs: z.number().int().nonnegative(),
  adapterCapabilityVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  strategyVersion: z.string().min(1),
  /**
   * Null when no LLM was involved, per `ApprovedEconomicIntent`. Nullable
   * rather than optional: "no model produced this" is a fact the record
   * states, not a field it omits.
   */
  modelVersion: z.string().min(1).nullable(),
  portfolioSnapshotVersion: z.string().min(1),
  marketSnapshotVersion: z.string().min(1),
  feeSnapshotVersion: z.string().min(1),
});

export type ApprovedOrderIntent = z.infer<typeof approvedOrderIntentSchema>;

/**
 * The provenance an order and every record derived from it carries, so a
 * fill can be traced back to the exact approval that authorized it without
 * the caller having to keep the intent alongside. The full set of versions
 * that produced the decision travels with it — policy, strategy, model, and
 * both snapshots — because `AGENTS.md` requires every economic record to
 * carry them, and an execution lifted out of its order (as the reconciliation
 * read does) has no parent left to inherit them from.
 */
export type OrderProvenance = {
  readonly intentId: string;
  readonly economicActionId: string;
  readonly positionPlanId: string;
  readonly correlationId: string;
  readonly policyVersion: string;
  readonly strategyVersion: string;
  /** Null when no LLM was involved. */
  readonly modelVersion: string | null;
  readonly portfolioSnapshotVersion: string;
  readonly marketSnapshotVersion: string;
  readonly feeSnapshotVersion: string;
};

/**
 * The economic ceiling the approval set. The adapter never widens it and
 * never renegotiates it — a submission whose worst case at the venue's own
 * capped price and fee would breach it is refused before the venue sees it.
 */
export type OrderEnvelope = {
  readonly maxSpend: DecimalString;
  readonly minAcceptableReceipt: DecimalString;
  readonly permittedResidual: DecimalString;
  readonly validUntil: IsoUtcTimestamp;
  readonly requiredFreshnessMs: number;
};
