import { assetIdSchema, operatingModeSchema } from "@vigil/contracts";
import { asc, eq, inArray } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  approvedIntents,
  intentCostComponents,
  costChargeBasisEnum,
  costComponentKindEnum,
  netEdgeBasisEnum,
  type CostChargeBasisValue,
  type CostComponentKindValue,
  type NetEdgeBasisValue,
} from "../schema/intents";
import { assetScales, MAX_ASSET_SCALE } from "../schema/journal";
import { parseIsoInstant } from "./instants";
import {
  postgresConstraintName,
  postgresErrorCode,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_NUMERIC_VALUE_OUT_OF_RANGE,
  PG_RAISE_EXCEPTION,
  PG_UNIQUE_VIOLATION,
} from "./pg-errors";

/**
 * Writing the authorization to spend.
 *
 * An `ApprovedEconomicIntent` is the one record that says money may move,
 * and `docs/resilience.md` §9 requires it to exist durably before anything
 * acts on it. This module writes it and reads it back; it decides nothing.
 * Whether an intent should have been approved at all is `@vigil/policy`'s
 * question, and how much the position should be is `@vigil/strategies`'.
 *
 * Two guarantees here are the database's rather than this module's, which
 * is what makes them true for a writer that never came through this file —
 * a backfill, a repair script, a later application:
 *
 * - an approved intent cannot be changed or removed — the
 *   `intent_lifecycle_guards` migration's trigger rejects every `UPDATE`
 *   and `DELETE`, so this module exports no function that could raise a
 *   spending limit after the fact;
 * - the same approved proposal delivered twice authorizes one spend —
 *   `approved_intents_idempotency_key_key` is a unique index, so the second
 *   delivery collides in the database rather than relying on this module's
 *   lookup having seen the first;
 * - an approved intent cleared its own cost hurdle, and its named cost
 *   components account for the total that hurdle was judged against — a
 *   check constraint and a deferred constraint trigger, so an intent whose
 *   economics does not add up cannot be committed at all.
 *
 * Everything else is boundary validation against `@vigil/contracts`,
 * deliberately a superset of the table's own constraints. A constraint
 * firing for input this module accepted therefore means the SQL and the
 * TypeScript have drifted apart — a bug in this package rather than
 * schema-legal input — and the refusal codes below name which rule fired so
 * that difference is visible instead of being flattened into one error.
 */

export const INTENT_STORE_DIAGNOSTIC_CODES = [
  /** A timestamp is not an ISO-8601 UTC instant on a real calendar day. */
  "INVALID_TIMESTAMP",
  /** An asset id is not a canonical `chainId|kind|value|withdrawalNetwork`. */
  "INVALID_ASSET",
  /** An asset scale is not a whole number in `0..MAX_ASSET_SCALE`. */
  "INVALID_SCALE",
  /** An amount is missing, negative, or authorizes nothing. */
  "INVALID_AMOUNT",
  /** The amount has more digits than a base-unit column holds. */
  "AMOUNT_OUT_OF_RANGE",
  /** The operating mode is not an `OPERATING_MODES` member. */
  "INVALID_OPERATING_MODE",
  /** The authorization does not expire after it was granted. */
  "INVALID_WINDOW",
  /** The required data freshness is not a positive whole number of milliseconds. */
  "INVALID_FRESHNESS",
  /** An on-chain route without a simulation that passed, or a verdict with no simulation. */
  "INVALID_CHAIN_VALIDATION",
  /** The record does not name every version that produced it. */
  "MISSING_PROVENANCE",
  /** A record does not name itself, its delivery, or what it authorizes. */
  "EMPTY_IDENTITY",
  /** The intent names a candidate that is not in durable history. */
  "UNKNOWN_CANDIDATE",
  /** The attempt or dispatch names an intent that is not in durable history. */
  "UNKNOWN_INTENT",
  /** The write names an execution attempt that is not in durable history. */
  "UNKNOWN_ATTEMPT",
  /** The write names a dispatch that is not in durable history. */
  "UNKNOWN_DISPATCH",
  /** One asset was used at two scales, or at a scale it is not registered with. */
  "SCALE_MISMATCH",
  /** The state is not an `execution_attempt_state` member. */
  "INVALID_STATE",
  /** The reason code is not a member of `@vigil/contracts`' `REASON_CODES`. */
  "INVALID_REASON_CODE",
  /** The payload digest is not lower-case SHA-256 hex. */
  "INVALID_PAYLOAD_DIGEST",
  /** The fencing token is not a positive whole number. */
  "INVALID_FENCING_TOKEN",
  /** An attempt on this intent is still live; reconcile it before opening another. */
  "INTENT_ALREADY_LIVE",
  /** This intent has already been economically consumed; a remainder is a new intent. */
  "INTENT_ALREADY_CONSUMED",
  /** The authorization had expired before this attempt was opened. */
  "INTENT_EXPIRED",
  /** The attempt is settled; a settled attempt takes no further writes. */
  "ATTEMPT_SETTLED",
  /** The dispatch is settled; a dispatched or abandoned row takes no further writes. */
  "DISPATCH_SETTLED",
  /** The writer carries a fencing token below the one holding this dispatch. */
  "WRITER_FENCED",
  /** An UNKNOWN attempt resolves only through reconciliation recorded in the same write. */
  "UNRECONCILED_UNKNOWN",
  /** The write would un-confirm money the attempt already recorded. */
  "OUTCOME_NOT_MONOTONIC",
  /** An id is already taken by a different record. */
  "DUPLICATE_RECORD",
  /** The economics does not add up, or is not internally consistent. */
  "INVALID_ECONOMICS",
  /** The named cost components do not sum to the claimed total incremental cost. */
  "COST_COMPONENTS_UNBALANCED",
  /** A cost in an asset other than the numeraire names no conversion source. */
  "MISSING_CONVERSION_SOURCE",
  /** The expected net edge does not reach the minimum the decision required. */
  "NET_EDGE_BELOW_MINIMUM",
  /** One intent names the same cost kind twice, which would double-count it. */
  "DUPLICATE_COST_COMPONENT",
  /**
   * The intent routes over a chain, and the exchange attempt lifecycle
   * cannot describe a broadcast. Not a defect in the caller so much as a
   * capability this application does not have yet: the `transactions`
   * record family is where an on-chain action gets a lifecycle.
   */
  "CHAIN_LIFECYCLE_UNSUPPORTED",
  /**
   * A state that asserts a fill reports no confirmed amounts. Refused
   * rather than stored, because a settled attempt that consumed nothing
   * leaves its authorization open to a second attempt.
   */
  "FILL_WITHOUT_AMOUNTS",
  /** The attempt is already associated with a different venue order. */
  "VENUE_ORDER_REASSIGNED",
  /** The intent's cost evidence was sealed when the intent was approved. */
  "COST_EVIDENCE_SEALED",
  /**
   * The request names an attempt or dispatch that exists under different
   * terms. Distinct from `DUPLICATE_RECORD`: a redelivery of the same work
   * is a duplicate, while a retry carrying a different payload is a caller
   * that would otherwise be told its payload was enqueued when a different
   * one was.
   */
  "PAYLOAD_MISMATCH",
  /** A check constraint or a lifecycle trigger rejected the write. */
  "CONSTRAINT_VIOLATION",
] as const;

export type IntentStoreDiagnosticCode = (typeof INTENT_STORE_DIAGNOSTIC_CODES)[number];

export type IntentRefusal = {
  readonly outcome: "refused";
  readonly code: IntentStoreDiagnosticCode;
  readonly detail: string;
};

export function refuseIntentWrite(code: IntentStoreDiagnosticCode, detail: string): IntentRefusal {
  return { outcome: "refused", code, detail };
}

/**
 * Turning a driver error from this record family into a diagnostic.
 *
 * The lifecycle triggers raise with an explicit `CONSTRAINT` name for
 * exactly this reason: a refusal arrives carrying the name of the rule that
 * fired, so "this intent is already consumed" and "this attempt is settled"
 * stay different answers instead of collapsing into one opaque check
 * violation. Anything unrecognised is returned as `null` and re-thrown by
 * the caller: an unreachable database is a failure, not a routine refusal.
 */
export function describeIntentDriverRefusal(
  error: unknown,
): { readonly code: IntentStoreDiagnosticCode; readonly detail: string } | null {
  const code = postgresErrorCode(error);
  const constraint = postgresConstraintName(error) ?? "unknown constraint";

  if (code === PG_CHECK_VIOLATION) {
    const named: Partial<Record<string, { code: IntentStoreDiagnosticCode; detail: string }>> = {
      execution_attempts_intent_not_consumed: {
        code: "INTENT_ALREADY_CONSUMED",
        detail: "this intent has already been economically consumed; a remainder is a new authorization, not a further attempt",
      },
      execution_attempts_within_intent_window: {
        code: "INTENT_EXPIRED",
        detail: "the authorization had expired before this attempt was opened",
      },
      execution_attempts_terminal_is_final: {
        code: "ATTEMPT_SETTLED",
        detail: "this attempt is settled; a reconciliation that disagrees with it is an incident, not an edit",
      },
      execution_attempts_unknown_needs_reconciliation: {
        code: "UNRECONCILED_UNKNOWN",
        detail: "an UNKNOWN attempt resolves only through reconciliation against the venue's confirmed state, recorded in the same write",
      },
      execution_attempts_outcome_monotonic: {
        code: "OUTCOME_NOT_MONOTONIC",
        detail: "the write would un-confirm money this attempt already recorded",
      },
      execution_attempts_scales_match_intent: {
        code: "SCALE_MISMATCH",
        detail: "the attempt denominates its amounts at a scale the intent did not authorize",
      },
      intent_dispatch_outbox_fencing_monotonic: {
        code: "WRITER_FENCED",
        detail: "this writer carries a fencing token below the one holding the dispatch",
      },
      intent_dispatch_outbox_terminal_is_final: {
        code: "DISPATCH_SETTLED",
        detail: "this dispatch is settled; a dispatched or abandoned row takes no further writes",
      },
      approved_intents_provenance_present: {
        code: "MISSING_PROVENANCE",
        detail: "the intent does not name every version that produced it",
      },
      approved_intents_net_edge_derived: {
        code: "INVALID_ECONOMICS",
        detail: "the expected net edge is not the expected gross less the expected total cost",
      },
      approved_intents_net_edge_hurdle: {
        code: "NET_EDGE_BELOW_MINIMUM",
        detail: "the intent does not reach the minimum net edge its own decision required, or declares an exemption and a minimum at once",
      },
      approved_intents_economics_sane: {
        code: "INVALID_ECONOMICS",
        detail: "the intent carries a negative total cost or a notional that is not positive",
      },
      approved_intents_quote_precedes_approval: {
        code: "INVALID_ECONOMICS",
        detail: "the quote behind this decision was acquired after the decision was made",
      },
      approved_intents_costs_itemised: {
        code: "COST_COMPONENTS_UNBALANCED",
        detail: "the named cost components do not sum to the total incremental cost the net edge was derived from",
      },
      intent_cost_components_itemised: {
        code: "COST_COMPONENTS_UNBALANCED",
        detail: "the named cost components do not sum to the total incremental cost the net edge was derived from",
      },
      intent_cost_components_conversion_declared: {
        code: "MISSING_CONVERSION_SOURCE",
        detail: "a cost charged in an asset other than the numeraire must name what converted it",
      },
      intent_cost_components_identity_conversion: {
        code: "INVALID_ECONOMICS",
        detail: "a cost already in the numeraire must convert to itself",
      },
      intent_cost_components_non_negative: {
        code: "INVALID_ECONOMICS",
        detail: "a negative cost would inflate net edge rather than reduce it",
      },
      intent_cost_components_sealed: {
        code: "COST_EVIDENCE_SEALED",
        detail: "this intent's cost evidence was sealed when it was approved; a cost discovered later is a new intent",
      },
      execution_attempts_exchange_intents_only: {
        code: "CHAIN_LIFECYCLE_UNSUPPORTED",
        detail: "this intent routes over a chain, and the exchange attempt lifecycle cannot describe a broadcast",
      },
      execution_attempts_correlation_matches_intent: {
        code: "CONSTRAINT_VIOLATION",
        detail: "the attempt is threaded under a different correlation id than the intent it consumes",
      },
      execution_attempts_fill_confirms_amounts: {
        code: "FILL_WITHOUT_AMOUNTS",
        detail: "a fill with no confirmed amounts would settle the attempt without consuming the intent",
      },
      execution_attempts_venue_order_assigned_once: {
        code: "VENUE_ORDER_REASSIGNED",
        detail: "the attempt is already associated with a different venue order",
      },
    };
    const match = named[constraint];
    if (match !== undefined) {
      return match;
    }
    return { code: "CONSTRAINT_VIOLATION", detail: `check constraint ${constraint} rejected the write` };
  }

  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint === "execution_attempts_intent_id_live_key") {
      return {
        code: "INTENT_ALREADY_LIVE",
        detail: "an attempt on this intent is still live; reconcile it before opening another",
      };
    }
    if (constraint === "execution_attempts_intent_id_consumed_key") {
      return {
        code: "INTENT_ALREADY_CONSUMED",
        detail: "this intent has already been economically consumed by another attempt",
      };
    }
    return { code: "DUPLICATE_RECORD", detail: `unique constraint ${constraint} rejected the write` };
  }

  if (code === PG_FOREIGN_KEY_VIOLATION) {
    if (constraint === "intent_cost_components_intent_numeraire_fk") {
      return {
        code: "INVALID_ECONOMICS",
        detail: "the cost component names an intent that is not in durable history, or a numeraire that intent never declared",
      };
    }
    if (constraint === "approved_intents_candidate_id_fk") {
      return { code: "UNKNOWN_CANDIDATE", detail: "the candidate this intent names is not in durable history" };
    }
    if (constraint === "execution_attempts_intent_id_fk") {
      return { code: "UNKNOWN_INTENT", detail: "the intent this attempt names is not in durable history" };
    }
    if (constraint === "intent_dispatch_outbox_attempt_fk") {
      return { code: "UNKNOWN_ATTEMPT", detail: "the execution attempt this dispatch names is not in durable history" };
    }
    if (constraint.endsWith("_asset_scale_fk")) {
      return {
        code: "SCALE_MISMATCH",
        detail: "the asset is registered at a different scale; one asset has exactly one scale",
      };
    }
    return { code: "CONSTRAINT_VIOLATION", detail: `foreign key ${constraint} rejected the write` };
  }

  if (code === PG_NUMERIC_VALUE_OUT_OF_RANGE) {
    return { code: "AMOUNT_OUT_OF_RANGE", detail: "the amount has more digits than a base-unit column holds" };
  }

  if (code === PG_RAISE_EXCEPTION) {
    return {
      code: "CONSTRAINT_VIOLATION",
      detail: "this record is append-only history and takes no update or delete",
    };
  }

  return null;
}

/**
 * The six version stamps an authorization carries. Wider than the journal's
 * `StoreProvenance` and stricter: an intent that cannot say which market,
 * portfolio, and fee snapshots sized it is not point-in-time reproducible,
 * so those three are required here where a posting may leave them null.
 */
export type IntentProvenance = {
  readonly policyVersion: string;
  readonly strategyVersion: string;
  /** Null when no LLM was involved. */
  readonly modelVersion: string | null;
  readonly portfolioSnapshotVersion: string;
  readonly marketSnapshotVersion: string;
  readonly feeSnapshotVersion: string;
};

/**
 * The side of the trade that is spent, and the side that is acquired. They
 * are separate objects rather than eight flat fields because every amount
 * below is denominated in one of the two assets, and a flat list is how a
 * receipt floor ends up compared against a spending cap in the other asset.
 */
export type IntentInputSide = {
  readonly assetId: string;
  readonly scale: number;
  /** The hard ceiling on base units this authorization may consume. */
  readonly maxSpendBase: bigint;
  /** Base units that may be left unspent without the action being incomplete. */
  readonly permittedResidualBase: bigint;
};

export type IntentOutputSide = {
  readonly assetId: string;
  readonly scale: number;
  /** How much this authorizes acquiring. */
  readonly quantityBase: bigint;
  /** The floor below which the trade is not worth doing. */
  readonly minAcceptableReceiptBase: bigint;
};

export const COST_COMPONENT_KINDS: Readonly<typeof costComponentKindEnum.enumValues> =
  costComponentKindEnum.enumValues;
export const COST_CHARGE_BASES: Readonly<typeof costChargeBasisEnum.enumValues> = costChargeBasisEnum.enumValues;
export const NET_EDGE_BASES: Readonly<typeof netEdgeBasisEnum.enumValues> = netEdgeBasisEnum.enumValues;

/**
 * One named cost between expected gross advantage and expected net edge.
 *
 * Both amounts are carried on purpose. `nativeAmountBase` is what the venue
 * actually charges, in the asset it charges it in; `numeraireAmountBase` is
 * that cost expressed in the intent's numeraire, and is the only figure
 * that is ever summed. `conversionSource` names what related the two, and
 * is required exactly when the assets differ — so no total in this family
 * is ever an addition of amounts in different assets with nothing recorded
 * about how they were compared.
 */
export type IntentCostComponent = {
  readonly kind: CostComponentKindValue;
  /** Taken out of the execution price, or billed alongside it. */
  readonly chargeBasis: CostChargeBasisValue;
  readonly nativeAssetId: string;
  readonly nativeScale: number;
  readonly nativeAmountBase: bigint;
  readonly numeraireAmountBase: bigint;
  /** Null exactly when the native asset is the numeraire. */
  readonly conversionSource: string | null;
};

/**
 * The point-in-time evidence that this action was worth doing, as it stood
 * when policy approved it (`docs/evaluation.md`, point-in-time integrity).
 *
 * Every figure is in base units of `numeraireAssetId`. The identities the
 * database enforces, and this module checks first so a caller gets a reason
 * code rather than a driver error: net edge is gross less total cost, the
 * components sum to the total cost, and — unless the decision was
 * explicitly exempt — net edge reaches `minimumNetEdgeBase`.
 */
export type IntentEconomics = {
  /** The quote or market snapshot the decision was made on. */
  readonly quoteId: string;
  /** ISO-8601 UTC; must not be after the approval. */
  readonly quoteAcquiredAt: string;
  /** The venue-economics / cost-model version that priced the costs. */
  readonly costModelVersion: string;
  readonly numeraireAssetId: string;
  readonly numeraireScale: number;
  /** Intended notional, in numeraire base units. */
  readonly notionalBase: bigint;
  /** Expected gross advantage before cost; negative for a protective unwind. */
  readonly expectedGrossBase: bigint;
  readonly expectedTotalCostBase: bigint;
  /** Gross less total cost. */
  readonly expectedNetEdgeBase: bigint;
  /**
   * `hurdle` when a configured minimum applied, `protective-exempt` when
   * none did. An exemption is recorded rather than inferred from a null, so
   * every intent that skipped the hurdle can be found.
   */
  readonly netEdgeBasis: NetEdgeBasisValue;
  /** Null exactly when `netEdgeBasis` is `protective-exempt`. */
  readonly minimumNetEdgeBase: bigint | null;
  /** At most one per kind; a repeated kind is a double-counted cost. */
  readonly costComponents: readonly IntentCostComponent[];
};

export type StoreApprovedIntent = {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly economicActionId: string;
  readonly positionPlanId: string;
  /** The journaled candidate this came from; null for a protective action. */
  readonly candidateId: string | null;
  /** An `OPERATING_MODES` member; `PAPER` today. Recording it grants no authority. */
  readonly operatingMode: string;
  readonly fundingAccountId: string;
  readonly venueId: string;
  /** Null for an exchange venue. */
  readonly chainId: string | null;
  /** Null when the venue needs no route selection. */
  readonly routeId: string | null;
  readonly input: IntentInputSide;
  readonly output: IntentOutputSide;
  /** ISO-8601 UTC; must be after `approvedAt`. */
  readonly validUntil: string;
  readonly requiredFreshnessMs: number;
  readonly protectionPlan: string | null;
  readonly remainingInventoryTreatment: string;
  readonly benchmarkId: string | null;
  readonly approvalReason: string | null;
  readonly adapterCapabilityVersion: string;
  /** Required, and must have passed, whenever `chainId` is set. */
  readonly chainValidation: { readonly simulationId: string; readonly passed: boolean } | null;
  /** ISO-8601 UTC. */
  readonly approvedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  readonly provenance: IntentProvenance;
  /** What made this worth doing, as it stood at approval. */
  readonly economics: IntentEconomics;
};

export type RecordApprovedIntentResult =
  | { readonly outcome: "recorded"; readonly intentId: string }
  /** This idempotency key already authorizes a spend; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly intentId: string }
  | IntentRefusal;

const BLANK = /^\s*$/u;

function blank(value: string): boolean {
  return BLANK.test(value);
}

function wholeNumber(value: number): boolean {
  return Number.isSafeInteger(value);
}

function validScale(scale: number): boolean {
  return wholeNumber(scale) && scale >= 0 && scale <= MAX_ASSET_SCALE;
}

async function findIntentIdByIdempotencyKey(db: VigilDatabase, idempotencyKey: string): Promise<string | null> {
  const rows = await db
    .select({ intentId: approvedIntents.intentId })
    .from(approvedIntents)
    .where(eq(approvedIntents.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0]?.intentId ?? null;
}

/** Everything about the record that must hold before any write is attempted. */
function checkApprovedIntent(intent: StoreApprovedIntent): IntentRefusal | null {
  const identities: ReadonlyArray<readonly [string, string]> = [
    ["intentId", intent.intentId],
    ["idempotencyKey", intent.idempotencyKey],
    ["correlationId", intent.correlationId],
    ["economicActionId", intent.economicActionId],
    ["positionPlanId", intent.positionPlanId],
    ["fundingAccountId", intent.fundingAccountId],
    ["venueId", intent.venueId],
    ["adapterCapabilityVersion", intent.adapterCapabilityVersion],
    ["remainingInventoryTreatment", intent.remainingInventoryTreatment],
  ];
  for (const [field, value] of identities) {
    if (blank(value)) {
      return refuseIntentWrite("EMPTY_IDENTITY", `the intent's ${field} is blank, so nothing names what it authorizes`);
    }
  }

  if (!operatingModeSchema.safeParse(intent.operatingMode).success) {
    return refuseIntentWrite(
      "INVALID_OPERATING_MODE",
      `intent ${intent.intentId} was approved in ${intent.operatingMode}, which is not an operating mode`,
    );
  }

  for (const [side, assetId] of [
    ["input", intent.input.assetId],
    ["output", intent.output.assetId],
  ] as const) {
    if (!assetIdSchema.safeParse(assetId).success) {
      return refuseIntentWrite(
        "INVALID_ASSET",
        `intent ${intent.intentId} names ${assetId} as its ${side} asset, which is not a canonical asset id`,
      );
    }
  }

  if (!validScale(intent.input.scale) || !validScale(intent.output.scale)) {
    return refuseIntentWrite(
      "INVALID_SCALE",
      `intent ${intent.intentId} carries scales (${intent.input.scale}, ${intent.output.scale}); a scale is a whole number in 0..${MAX_ASSET_SCALE}`,
    );
  }

  if (intent.output.quantityBase <= 0n || intent.input.maxSpendBase <= 0n) {
    return refuseIntentWrite(
      "INVALID_AMOUNT",
      `intent ${intent.intentId} authorizes acquiring ${intent.output.quantityBase.toString()} for at most ${intent.input.maxSpendBase.toString()} base units, which authorizes nothing`,
    );
  }

  if (intent.output.minAcceptableReceiptBase < 0n || intent.input.permittedResidualBase < 0n) {
    return refuseIntentWrite("INVALID_AMOUNT", `intent ${intent.intentId} carries a negative floor or residual`);
  }

  if (intent.input.permittedResidualBase > intent.input.maxSpendBase) {
    return refuseIntentWrite(
      "INVALID_AMOUNT",
      `intent ${intent.intentId} permits a residual of ${intent.input.permittedResidualBase.toString()} against a spending cap of ${intent.input.maxSpendBase.toString()}`,
    );
  }

  if (!wholeNumber(intent.requiredFreshnessMs) || intent.requiredFreshnessMs <= 0) {
    return refuseIntentWrite(
      "INVALID_FRESHNESS",
      `intent ${intent.intentId} requires a data freshness of ${intent.requiredFreshnessMs}ms; a window that is not a positive whole number of milliseconds accepts any staleness`,
    );
  }

  const approvedAt = parseIsoInstant(intent.approvedAt);
  const recordedAt = parseIsoInstant(intent.recordedAt);
  const validUntil = parseIsoInstant(intent.validUntil);
  if (approvedAt === null || recordedAt === null || validUntil === null) {
    return refuseIntentWrite(
      "INVALID_TIMESTAMP",
      `intent ${intent.intentId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }
  if (validUntil.getTime() <= approvedAt.getTime()) {
    return refuseIntentWrite(
      "INVALID_WINDOW",
      `intent ${intent.intentId} is valid until ${intent.validUntil}, which is not after the ${intent.approvedAt} it was approved at`,
    );
  }

  // `docs/architecture.md` "Execution lifecycles": an on-chain action
  // reaches POLICY_VALIDATED only after SIMULATED, so an on-chain
  // authorization without a simulation that passed is not an authorization.
  if (intent.chainId !== null && (intent.chainValidation === null || !intent.chainValidation.passed)) {
    return refuseIntentWrite(
      "INVALID_CHAIN_VALIDATION",
      `intent ${intent.intentId} routes over chain ${intent.chainId} without a simulation that passed`,
    );
  }
  if (intent.chainValidation !== null && blank(intent.chainValidation.simulationId)) {
    return refuseIntentWrite(
      "INVALID_CHAIN_VALIDATION",
      `intent ${intent.intentId} carries a simulation verdict that does not name the simulation it came from`,
    );
  }

  const stamps: ReadonlyArray<readonly [string, string]> = [
    ["policyVersion", intent.provenance.policyVersion],
    ["strategyVersion", intent.provenance.strategyVersion],
    ["portfolioSnapshotVersion", intent.provenance.portfolioSnapshotVersion],
    ["marketSnapshotVersion", intent.provenance.marketSnapshotVersion],
    ["feeSnapshotVersion", intent.provenance.feeSnapshotVersion],
  ];
  for (const [field, value] of stamps) {
    if (blank(value)) {
      return refuseIntentWrite(
        "MISSING_PROVENANCE",
        `intent ${intent.intentId} does not name the ${field} that produced it`,
      );
    }
  }

  return checkEconomics(intent);
}

/**
 * The economics, checked before any write.
 *
 * Every rule below is also a database constraint. Checking here first is
 * what turns each of them into its own reason code: a caller that supplied
 * an unbalanced breakdown and a caller that missed its hurdle have made
 * different mistakes, and a single `CONSTRAINT_VIOLATION` would tell
 * neither of them which.
 */
function checkEconomics(intent: StoreApprovedIntent): IntentRefusal | null {
  const economics = intent.economics;
  const where = `intent ${intent.intentId}`;

  for (const [field, value] of [
    ["quoteId", economics.quoteId],
    ["costModelVersion", economics.costModelVersion],
  ] as const) {
    if (blank(value)) {
      return refuseIntentWrite(
        "INVALID_ECONOMICS",
        `${where} does not name the ${field} its cost assumptions came from`,
      );
    }
  }

  if (!assetIdSchema.safeParse(economics.numeraireAssetId).success) {
    return refuseIntentWrite(
      "INVALID_ASSET",
      `${where} settles in ${economics.numeraireAssetId}, which is not a canonical asset id`,
    );
  }

  if (!validScale(economics.numeraireScale)) {
    return refuseIntentWrite(
      "INVALID_SCALE",
      `${where} carries a numeraire scale of ${economics.numeraireScale}; a scale is a whole number in 0..${MAX_ASSET_SCALE}`,
    );
  }

  const quoteAcquiredAt = parseIsoInstant(economics.quoteAcquiredAt);
  const approvedAt = parseIsoInstant(intent.approvedAt);
  if (quoteAcquiredAt === null) {
    return refuseIntentWrite(
      "INVALID_TIMESTAMP",
      `${where} was decided on a quote acquired at ${economics.quoteAcquiredAt}, which is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }
  if (approvedAt !== null && quoteAcquiredAt.getTime() > approvedAt.getTime()) {
    return refuseIntentWrite(
      "INVALID_ECONOMICS",
      `${where} was approved at ${intent.approvedAt} on a quote acquired afterwards, at ${economics.quoteAcquiredAt}`,
    );
  }

  if (economics.notionalBase <= 0n) {
    return refuseIntentWrite("INVALID_ECONOMICS", `${where} carries a notional of ${economics.notionalBase.toString()}`);
  }

  if (economics.expectedTotalCostBase < 0n) {
    return refuseIntentWrite(
      "INVALID_ECONOMICS",
      `${where} carries a negative total cost, which would inflate net edge rather than reduce it`,
    );
  }

  if (economics.expectedNetEdgeBase !== economics.expectedGrossBase - economics.expectedTotalCostBase) {
    return refuseIntentWrite(
      "INVALID_ECONOMICS",
      `${where} reports a net edge of ${economics.expectedNetEdgeBase.toString()}, which is not its gross ${economics.expectedGrossBase.toString()} less its cost ${economics.expectedTotalCostBase.toString()}`,
    );
  }

  if (!NET_EDGE_BASES.includes(economics.netEdgeBasis)) {
    return refuseIntentWrite("INVALID_ECONOMICS", `${where} names ${economics.netEdgeBasis}, which is not a net-edge basis`);
  }

  const hurdle = economics.netEdgeBasis === "hurdle";
  if (hurdle !== (economics.minimumNetEdgeBase !== null)) {
    return refuseIntentWrite(
      "INVALID_ECONOMICS",
      hurdle
        ? `${where} was judged against a hurdle but names no minimum net edge`
        : `${where} declares itself exempt from the net-edge hurdle and names a minimum anyway`,
    );
  }

  if (economics.minimumNetEdgeBase !== null && economics.expectedNetEdgeBase < economics.minimumNetEdgeBase) {
    return refuseIntentWrite(
      "NET_EDGE_BELOW_MINIMUM",
      `${where} expects a net edge of ${economics.expectedNetEdgeBase.toString()} against a required minimum of ${economics.minimumNetEdgeBase.toString()}`,
    );
  }

  const seen = new Set<string>();
  let itemised = 0n;
  for (const component of economics.costComponents) {
    if (!COST_COMPONENT_KINDS.includes(component.kind)) {
      return refuseIntentWrite("INVALID_ECONOMICS", `${where} names ${component.kind}, which is not a cost component kind`);
    }
    if (!COST_CHARGE_BASES.includes(component.chargeBasis)) {
      return refuseIntentWrite(
        "INVALID_ECONOMICS",
        `${where} charges its ${component.kind} on a basis of ${component.chargeBasis}, which is neither embedded nor separately charged`,
      );
    }
    if (seen.has(component.kind)) {
      return refuseIntentWrite(
        "DUPLICATE_COST_COMPONENT",
        `${where} names its ${component.kind} cost twice, which would count it twice`,
      );
    }
    seen.add(component.kind);

    if (!assetIdSchema.safeParse(component.nativeAssetId).success) {
      return refuseIntentWrite(
        "INVALID_ASSET",
        `${where} charges its ${component.kind} in ${component.nativeAssetId}, which is not a canonical asset id`,
      );
    }
    if (!validScale(component.nativeScale)) {
      return refuseIntentWrite(
        "INVALID_SCALE",
        `${where} carries a ${component.kind} scale of ${component.nativeScale}`,
      );
    }
    if (component.nativeAmountBase < 0n || component.numeraireAmountBase < 0n) {
      return refuseIntentWrite(
        "INVALID_ECONOMICS",
        `${where} carries a negative ${component.kind} cost, which would inflate net edge rather than reduce it`,
      );
    }

    const crossesAssets = component.nativeAssetId !== economics.numeraireAssetId;
    const declared = component.conversionSource !== null && !blank(component.conversionSource);
    if (crossesAssets && !declared) {
      return refuseIntentWrite(
        "MISSING_CONVERSION_SOURCE",
        `${where} charges its ${component.kind} in ${component.nativeAssetId} and settles in ${economics.numeraireAssetId} without naming what converted between them`,
      );
    }
    if (!crossesAssets && component.conversionSource !== null) {
      return refuseIntentWrite(
        "INVALID_ECONOMICS",
        `${where} names a conversion for its ${component.kind} cost, which is already in the numeraire`,
      );
    }
    if (!crossesAssets && component.nativeAmountBase !== component.numeraireAmountBase) {
      return refuseIntentWrite(
        "INVALID_ECONOMICS",
        `${where} converts its ${component.kind} cost from ${component.nativeAmountBase.toString()} to ${component.numeraireAmountBase.toString()} in the same asset`,
      );
    }

    itemised += component.numeraireAmountBase;
  }

  if (itemised !== economics.expectedTotalCostBase) {
    return refuseIntentWrite(
      "COST_COMPONENTS_UNBALANCED",
      `${where} claims a total incremental cost of ${economics.expectedTotalCostBase.toString()} and names components summing to ${itemised.toString()}`,
    );
  }

  return checkScalesAgree(intent);
}

/**
 * One asset, one scale — within a single record, before the database's
 * `asset_scales` foreign keys get a chance to say the same thing less
 * clearly. A record that used an asset at two scales would register the
 * first and then be refused for the second, and the refusal would point at
 * the registry rather than at the two fields that disagree.
 *
 * The code is `SCALE_MISMATCH`, the same one `journal-store.ts` returns from
 * `describeScaleClash` and from the `_asset_scale_fk` mapping. Both halves
 * of that store's definition — "posted at two scales, or at a scale it is
 * not registered with" — are one condition with one name, and giving this
 * half a second name would leave two stores in this package disagreeing
 * about what to call the same fault. The *detail* is what distinguishes
 * them: this one names the two disagreeing fields, the foreign-key mapping
 * names the registry.
 */
function checkScalesAgree(intent: StoreApprovedIntent): IntentRefusal | null {
  const scales = new Map<string, number>();
  const used: ReadonlyArray<readonly [string, number]> = [
    [intent.input.assetId, intent.input.scale],
    [intent.output.assetId, intent.output.scale],
    [intent.economics.numeraireAssetId, intent.economics.numeraireScale],
    ...intent.economics.costComponents.map((component) => [component.nativeAssetId, component.nativeScale] as const),
  ];

  for (const [assetId, scale] of used) {
    const seen = scales.get(assetId);
    if (seen !== undefined && seen !== scale) {
      return refuseIntentWrite(
        "SCALE_MISMATCH",
        `intent ${intent.intentId} uses ${assetId} at scale ${seen} and at scale ${scale}; one asset has exactly one scale`,
      );
    }
    scales.set(assetId, scale);
  }

  return null;
}

/**
 * Record the authorization to spend.
 *
 * The write registers both assets' scales first, for the reason
 * `reserveAvailable` already does: the amount columns carry composite
 * `(asset_id, asset_scale)` foreign keys, so an asset used at a scale the
 * registry disagrees with comes back as `SCALE_MISMATCH` rather than a
 * foreign-key crash. The two rows go in one statement in asset-id order, so
 * two transactions registering the same pair cannot deadlock against each
 * other.
 */
export async function recordApprovedIntent(
  db: VigilDatabase,
  intent: StoreApprovedIntent,
): Promise<RecordApprovedIntentResult> {
  const refusal = checkApprovedIntent(intent);
  if (refusal !== null) {
    return refusal;
  }

  const approvedAt = parseIsoInstant(intent.approvedAt);
  const recordedAt = parseIsoInstant(intent.recordedAt);
  const validUntil = parseIsoInstant(intent.validUntil);
  const quoteAcquiredAt = parseIsoInstant(intent.economics.quoteAcquiredAt);
  if (approvedAt === null || recordedAt === null || validUntil === null || quoteAcquiredAt === null) {
    // Unreachable: `checkApprovedIntent` parsed all four. Narrowing them
    // again here is cheaper than carrying them out of that function.
    return refuseIntentWrite("INVALID_TIMESTAMP", `intent ${intent.intentId} carries an unparseable timestamp`);
  }

  const existing = await findIntentIdByIdempotencyKey(db, intent.idempotencyKey);
  if (existing !== null) {
    return { outcome: "duplicate", intentId: existing };
  }

  const scaleRows = [
    { assetId: intent.input.assetId, assetScale: intent.input.scale },
    { assetId: intent.output.assetId, assetScale: intent.output.scale },
    { assetId: intent.economics.numeraireAssetId, assetScale: intent.economics.numeraireScale },
    ...intent.economics.costComponents.map((component) => ({
      assetId: component.nativeAssetId,
      assetScale: component.nativeScale,
    })),
  ]
    .filter((row, index, rows) => rows.findIndex((other) => other.assetId === row.assetId) === index)
    .sort((left, right) => {
      if (left.assetId === right.assetId) {
        return 0;
      }
      return left.assetId < right.assetId ? -1 : 1;
    });

  try {
    await db.transaction(async (tx) => {
      await tx.insert(assetScales).values(scaleRows).onConflictDoNothing({ target: assetScales.assetId });

      await tx.insert(approvedIntents).values({
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        correlationId: intent.correlationId,
        economicActionId: intent.economicActionId,
        positionPlanId: intent.positionPlanId,
        candidateId: intent.candidateId,
        operatingMode: intent.operatingMode,
        fundingAccountId: intent.fundingAccountId,
        venueId: intent.venueId,
        chainId: intent.chainId,
        routeId: intent.routeId,
        inputAssetId: intent.input.assetId,
        inputAssetScale: intent.input.scale,
        outputAssetId: intent.output.assetId,
        outputAssetScale: intent.output.scale,
        quantityBase: intent.output.quantityBase,
        maxSpendBase: intent.input.maxSpendBase,
        minAcceptableReceiptBase: intent.output.minAcceptableReceiptBase,
        permittedResidualBase: intent.input.permittedResidualBase,
        validUntil,
        requiredFreshnessMs: intent.requiredFreshnessMs,
        protectionPlan: intent.protectionPlan,
        remainingInventoryTreatment: intent.remainingInventoryTreatment,
        benchmarkId: intent.benchmarkId,
        approvalReason: intent.approvalReason,
        adapterCapabilityVersion: intent.adapterCapabilityVersion,
        chainSimulationId: intent.chainValidation?.simulationId ?? null,
        chainSimulationPassed: intent.chainValidation?.passed ?? null,
        approvedAt,
        recordedAt,
        numeraireAssetId: intent.economics.numeraireAssetId,
        numeraireAssetScale: intent.economics.numeraireScale,
        quoteId: intent.economics.quoteId,
        quoteAcquiredAt,
        costModelVersion: intent.economics.costModelVersion,
        notionalBase: intent.economics.notionalBase,
        expectedGrossBase: intent.economics.expectedGrossBase,
        expectedTotalCostBase: intent.economics.expectedTotalCostBase,
        expectedNetEdgeBase: intent.economics.expectedNetEdgeBase,
        netEdgeBasis: intent.economics.netEdgeBasis,
        minimumNetEdgeBase: intent.economics.minimumNetEdgeBase,
        policyVersion: intent.provenance.policyVersion,
        strategyVersion: intent.provenance.strategyVersion,
        modelVersion: intent.provenance.modelVersion,
        portfolioSnapshotVersion: intent.provenance.portfolioSnapshotVersion,
        marketSnapshotVersion: intent.provenance.marketSnapshotVersion,
        feeSnapshotVersion: intent.provenance.feeSnapshotVersion,
      });

      // Same transaction, necessarily: the `costs_itemised` constraint
      // trigger is deferred to commit and compares the components against
      // the total the intent claims, so an intent whose breakdown is
      // written later could never be committed at all.
      if (intent.economics.costComponents.length > 0) {
        await tx.insert(intentCostComponents).values(
          intent.economics.costComponents.map((component) => ({
            intentId: intent.intentId,
            kind: component.kind,
            chargeBasis: component.chargeBasis,
            nativeAssetId: component.nativeAssetId,
            nativeAssetScale: component.nativeScale,
            nativeAmountBase: component.nativeAmountBase,
            numeraireAssetId: intent.economics.numeraireAssetId,
            numeraireAssetScale: intent.economics.numeraireScale,
            numeraireAmountBase: component.numeraireAmountBase,
            conversionSource: component.conversionSource,
          })),
        );
      }
    });
  } catch (error) {
    const driver = describeIntentDriverRefusal(error);
    if (driver === null) {
      throw error;
    }

    // A duplicate here is the same authorization arriving twice
    // concurrently: the lookup above found nothing because the winner had
    // not committed yet. Report the intent that exists rather than a
    // refusal — but only when it is this idempotency key that collided,
    // since an id or an economic action taken by a *different* delivery is
    // a real refusal the caller has to see.
    if (driver.code === "DUPLICATE_RECORD") {
      const duplicate = await findIntentIdByIdempotencyKey(db, intent.idempotencyKey);
      if (duplicate !== null) {
        return { outcome: "duplicate", intentId: duplicate };
      }
    }

    return refuseIntentWrite(driver.code, driver.detail);
  }

  return { outcome: "recorded", intentId: intent.intentId };
}

function toCostComponent(row: typeof intentCostComponents.$inferSelect): IntentCostComponent {
  return {
    kind: row.kind,
    chargeBasis: row.chargeBasis,
    nativeAssetId: row.nativeAssetId,
    nativeScale: row.nativeAssetScale,
    nativeAmountBase: row.nativeAmountBase,
    numeraireAmountBase: row.numeraireAmountBase,
    conversionSource: row.conversionSource,
  };
}

/**
 * The cost components of several intents at once, keyed by intent.
 *
 * One query for the whole set rather than one per intent: the breakdown is
 * read back beside every intent this module returns, and a per-intent query
 * would turn a correlation lookup into a query per authorization.
 */
async function loadCostComponents(
  db: VigilDatabase,
  intentIds: readonly string[],
): Promise<Map<string, IntentCostComponent[]>> {
  const byIntent = new Map<string, IntentCostComponent[]>();
  if (intentIds.length === 0) {
    return byIntent;
  }

  const rows = await db
    .select()
    .from(intentCostComponents)
    .where(inArray(intentCostComponents.intentId, [...intentIds]))
    .orderBy(asc(intentCostComponents.intentId), asc(intentCostComponents.kind));

  for (const row of rows) {
    const existing = byIntent.get(row.intentId);
    if (existing === undefined) {
      byIntent.set(row.intentId, [toCostComponent(row)]);
    } else {
      existing.push(toCostComponent(row));
    }
  }

  return byIntent;
}

function toStoreApprovedIntent(
  row: typeof approvedIntents.$inferSelect,
  costComponents: readonly IntentCostComponent[],
): StoreApprovedIntent {
  return {
    intentId: row.intentId,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    economicActionId: row.economicActionId,
    positionPlanId: row.positionPlanId,
    candidateId: row.candidateId,
    operatingMode: row.operatingMode,
    fundingAccountId: row.fundingAccountId,
    venueId: row.venueId,
    chainId: row.chainId,
    routeId: row.routeId,
    input: {
      assetId: row.inputAssetId,
      scale: row.inputAssetScale,
      maxSpendBase: row.maxSpendBase,
      permittedResidualBase: row.permittedResidualBase,
    },
    output: {
      assetId: row.outputAssetId,
      scale: row.outputAssetScale,
      quantityBase: row.quantityBase,
      minAcceptableReceiptBase: row.minAcceptableReceiptBase,
    },
    validUntil: row.validUntil.toISOString(),
    requiredFreshnessMs: row.requiredFreshnessMs,
    protectionPlan: row.protectionPlan,
    remainingInventoryTreatment: row.remainingInventoryTreatment,
    benchmarkId: row.benchmarkId,
    approvalReason: row.approvalReason,
    adapterCapabilityVersion: row.adapterCapabilityVersion,
    chainValidation:
      row.chainSimulationId === null || row.chainSimulationPassed === null
        ? null
        : { simulationId: row.chainSimulationId, passed: row.chainSimulationPassed },
    approvedAt: row.approvedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    provenance: {
      policyVersion: row.policyVersion,
      strategyVersion: row.strategyVersion,
      modelVersion: row.modelVersion,
      portfolioSnapshotVersion: row.portfolioSnapshotVersion,
      marketSnapshotVersion: row.marketSnapshotVersion,
      feeSnapshotVersion: row.feeSnapshotVersion,
    },
    economics: {
      quoteId: row.quoteId,
      quoteAcquiredAt: row.quoteAcquiredAt.toISOString(),
      costModelVersion: row.costModelVersion,
      numeraireAssetId: row.numeraireAssetId,
      numeraireScale: row.numeraireAssetScale,
      notionalBase: row.notionalBase,
      expectedGrossBase: row.expectedGrossBase,
      expectedTotalCostBase: row.expectedTotalCostBase,
      expectedNetEdgeBase: row.expectedNetEdgeBase,
      netEdgeBasis: row.netEdgeBasis,
      minimumNetEdgeBase: row.minimumNetEdgeBase,
      costComponents,
    },
  };
}

/** One authorization and the economics that justified it, or null. */
export async function loadApprovedIntent(db: VigilDatabase, intentId: string): Promise<StoreApprovedIntent | null> {
  const rows = await db.select().from(approvedIntents).where(eq(approvedIntents.intentId, intentId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const components = await loadCostComponents(db, [intentId]);
  return toStoreApprovedIntent(row, components.get(intentId) ?? []);
}

/**
 * Every authorization tied to one correlation id, oldest approval first.
 * The read a reconciliation walks to answer "what did this application
 * authorize for this decision, and in what order".
 */
export async function loadApprovedIntentsByCorrelation(
  db: VigilDatabase,
  correlationId: string,
): Promise<readonly StoreApprovedIntent[]> {
  const rows = await db
    .select()
    .from(approvedIntents)
    .where(eq(approvedIntents.correlationId, correlationId))
    .orderBy(asc(approvedIntents.approvedAt), asc(approvedIntents.intentId));

  const components = await loadCostComponents(
    db,
    rows.map((row) => row.intentId),
  );
  return rows.map((row) => toStoreApprovedIntent(row, components.get(row.intentId) ?? []));
}
