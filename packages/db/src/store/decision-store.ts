import { assetIdSchema, decimalStringSchema, reasonCodeSchema } from "@vigil/contracts";
import { asc, desc, eq } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import {
  candidateEvaluations,
  candidateHorizonEnum,
  candidateOutcomeEnum,
  candidates,
  candidateTranches,
  positionPlans,
} from "../schema/decisions";
import { parseIsoInstant } from "./instants";
import type { StoreProvenance } from "./journal-store";
import { postgresConstraintName, postgresErrorCode, PG_FOREIGN_KEY_VIOLATION } from "./pg-errors";

/**
 * Writing and reading the opportunity journal.
 *
 * Every policy-eligible candidate is recorded **before** its outcome is
 * known — entered, waited on, missed, and blocked all get a record at the
 * same point in the pipeline, not just the ones that turn into trades
 * (`docs/evaluation.md` "Opportunity journal"). This module is what makes
 * that durable, and it decides nothing: eligibility, sizing, and the choice
 * of reason code belong to `@vigil/policy` and `@vigil/strategies`
 * (`packages/db/README.md`).
 *
 * Two guarantees are the database's rather than this module's:
 *
 * - an outcome cannot exist without its candidate — `candidate_id` is
 *   `NOT NULL` with a foreign key, so `recordCandidateEvaluation` for a
 *   candidate nobody wrote down is refused with nothing persisted;
 * - a candidate cannot be rewritten once stored — the
 *   `candidate_append_only_guard` migration's trigger rejects every `UPDATE`
 *   and `DELETE`, so this module exports no function that could turn a
 *   missed entry into a BUY after the fact.
 *
 * Everything else is boundary validation: each value is checked against the
 * registries and schemas in `@vigil/contracts` before it is written, and a
 * value that fails comes back as a diagnostic rather than a driver error
 * (`docs/resilience.md` §4, §5). That validation is deliberately a superset
 * of the tables' own check constraints, so a constraint firing here means
 * the SQL and the TypeScript have drifted apart — a bug in this package, not
 * schema-legal input — and is re-thrown rather than dressed up as a refusal.
 */

export const DECISION_STORE_DIAGNOSTIC_CODES = [
  /** A timestamp is not an ISO-8601 UTC instant on a real calendar day. */
  "INVALID_TIMESTAMP",
  /** A price or quantity is not a non-negative decimal string. */
  "INVALID_DECIMAL",
  /** The reason code is not a member of `@vigil/contracts`' `REASON_CODES`. */
  "INVALID_REASON_CODE",
  /** The outcome is not a member of `CANDIDATE_OUTCOMES`. */
  "INVALID_OUTCOME",
  /** The horizon is not a member of `CANDIDATE_HORIZONS`. */
  "INVALID_HORIZON",
  /** The candidate carries no position plan at all. */
  "EMPTY_PLAN",
  /** The evaluation names a candidate that is not in durable history. */
  "UNKNOWN_CANDIDATE",
  /** The record does not name the policy and strategy versions that produced it. */
  "MISSING_PROVENANCE",
  /**
   * The instrument id is not two canonical asset ids joined by `/`. A bare
   * ticker pair is the identity bug `@vigil/contracts` exists to prevent
   * (`AGENTS.md`: asset identity is chain plus contract, mint, or native
   * denomination plus withdrawal network, never a ticker alone).
   */
  "INVALID_INSTRUMENT",
  /**
   * The position plan's tranches are not indexed 0..n-1. Distinct from
   * `EMPTY_PLAN`: a plan with a gap or a repeated index is not an empty one,
   * and a code that said so would be evidence that lies.
   */
  "INVALID_PLAN",
  /**
   * A position plan id is already stored under different terms. Refused
   * rather than reconciled: the entry zone and the exit price are what a
   * later dispatch re-measures the economics against, so an intent approved
   * under terms the stored plan does not carry would be revalidated against
   * something other than what approved it — and whichever of the two won
   * would be silent.
   */
  "PLAN_TERMS_CONFLICT",
  /**
   * The id is already stored under a *different* idempotency key, so this is
   * not the same delivery arriving twice — it is a second record claiming an
   * id that is taken. Reported rather than thrown, because a producer that
   * regenerates ids after a restart supplies schema-legal input
   * (`docs/resilience.md` §4), and silently answering `duplicate` would drop
   * a candidate that was never persisted.
   */
  "DUPLICATE_RECORD",
  /**
   * A record does not name itself, its delivery, or what produced it. A
   * blank id is not a missing column the database can catch — `''` satisfies
   * `NOT NULL` and is a perfectly good primary key — so a candidate keyed on
   * the empty string would take the one row that every other unnamed
   * candidate then collides with. The same code name the heartbeat store
   * uses for the same refusal.
   */
  "EMPTY_IDENTITY",
] as const;

export type DecisionStoreDiagnosticCode = (typeof DECISION_STORE_DIAGNOSTIC_CODES)[number];

/**
 * Derived from the Postgres enums rather than restated beside them: a
 * registry that is hand-copied next to the column it describes is a registry
 * that drifts from it, and the drift shows up as a write the database
 * refuses for a value the application believes in. `Readonly` gives the
 * derived tuple the same shape an `as const` registry has, so a consumer
 * cannot push a fifth outcome into the array every other consumer reads.
 */
export const CANDIDATE_OUTCOMES: Readonly<typeof candidateOutcomeEnum.enumValues> = candidateOutcomeEnum.enumValues;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

export const CANDIDATE_HORIZONS: Readonly<typeof candidateHorizonEnum.enumValues> = candidateHorizonEnum.enumValues;
export type CandidateHorizon = (typeof CANDIDATE_HORIZONS)[number];

export type StoreTranche = {
  readonly index: number;
  readonly quantity: string;
  readonly triggerPrice: string | null;
};

export type StoreCandidate = {
  readonly candidateId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly strategyId: string;
  /** Canonical instrument id text: `baseAssetId/quoteAssetId`. */
  readonly instrumentId: string;
  /** `BUY` today; free text kept for the product action vocabulary. */
  readonly action: string;
  /** For example `SMALL_STARTER`; preserves MISSED_ENTRY/WAIT distinctions downstream. */
  readonly actionDetail: string;
  readonly horizon: CandidateHorizon;
  readonly entryZoneMin: string;
  readonly entryZoneMax: string;
  /** Price distance above `entryZoneMax` that still counts as WAIT. */
  readonly allowedExtension: string;
  /** An executable price below this invalidates the thesis. */
  readonly invalidationPrice: string;
  readonly invalidationConditions: readonly string[];
  /** ISO-8601 UTC. */
  readonly expiresAt: string;
  readonly benchmarkId: string;
  readonly marketSnapshot: {
    /** ISO-8601 UTC. */
    readonly quoteAcquiredAt: string;
    /** ISO-8601 UTC. */
    readonly ingestedAt: string;
    readonly bidPrice: string;
    readonly askPrice: string;
  };
  /** ISO-8601 UTC; the analysis-completion stage of the timestamp family. */
  readonly generatedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  readonly provenance: StoreProvenance;
  /** At least one; indexed 0..n-1. */
  readonly tranches: readonly StoreTranche[];
};

export type StoreCandidateEvaluation = {
  readonly evaluationId: string;
  readonly idempotencyKey: string;
  readonly candidateId: string;
  readonly outcome: CandidateOutcome;
  /** A `REASON_CODES` member when non-null. */
  readonly reasonCode: string | null;
  readonly detail: string;
  /** Null when the outcome was reached without a usable executable price. */
  readonly executablePrice: string | null;
  /** ISO-8601 UTC; null with `executablePrice`. */
  readonly quoteAcquiredAt: string | null;
  /** ISO-8601 UTC. */
  readonly evaluatedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
};

export type StoredCandidate = StoreCandidate & {
  readonly latestEvaluation: StoreCandidateEvaluation | null;
};

export type RecordCandidateResult =
  | { readonly outcome: "recorded"; readonly candidateId: string }
  /** This idempotency key is already stored; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly candidateId: string }
  | { readonly outcome: "refused"; readonly code: DecisionStoreDiagnosticCode; readonly detail: string };

export type RecordEvaluationResult =
  | { readonly outcome: "recorded"; readonly evaluationId: string }
  /** This idempotency key is already stored; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly evaluationId: string }
  | { readonly outcome: "refused"; readonly code: DecisionStoreDiagnosticCode; readonly detail: string };

/**
 * The durable terms of a staged position plan, as they are written and read
 * back (`position_plans`).
 *
 * Prices are decimal text, like every other amount in this family: nothing
 * in this package adds them up, and text is what round-trips a price
 * unchanged. The execution runtime parses them against
 * `@vigil/contracts`' decimal schema at the point it uses them.
 */
export type StorePositionPlan = {
  /** The id `approved_intents.position_plan_id` names. */
  readonly positionPlanId: string;
  readonly correlationId: string;
  /** Canonical instrument id text: `baseAssetId/quoteAssetId`. */
  readonly instrumentId: string;
  readonly entryZoneMin: string;
  readonly entryZoneMax: string;
  /** The price the thesis expects the position to be worth. */
  readonly thesisExitPrice: string;
  /**
   * The midpoint the terms above were set against — evidence that makes the
   * exit price interpretable later, never an input to a dispatch-time
   * calculation. Recorded by the write that first stores the plan: a later
   * step of the same plan is approved at a different midpoint, which is that
   * step's own figure and not a re-formation of these terms.
   */
  readonly formationReferenceMid: string;
  /** ISO-8601 UTC; when the terms were set. */
  readonly formedAt: string;
  /** ISO-8601 UTC; must not precede `formedAt`. */
  readonly recordedAt: string;
  readonly provenance: StoreProvenance;
};

/** What a stored plan reads back as. Every field is written, so nothing is added. */
export type StoredPositionPlan = StorePositionPlan;

export type RecordPositionPlanResult =
  | { readonly outcome: "recorded"; readonly positionPlanId: string }
  /** This plan is already stored under these same terms; nothing new was written. */
  | { readonly outcome: "duplicate"; readonly positionPlanId: string }
  | { readonly outcome: "refused"; readonly code: DecisionStoreDiagnosticCode; readonly detail: string };

type DecisionRefusal = {
  readonly outcome: "refused";
  readonly code: DecisionStoreDiagnosticCode;
  readonly detail: string;
};

function refuse(code: DecisionStoreDiagnosticCode, detail: string): DecisionRefusal {
  return { outcome: "refused", code, detail };
}

/**
 * Every amount in this family is a price, a quantity, or a distance between
 * two prices, so a leading `-` is refused on top of the shared decimal-string
 * shape. `decimalStringSchema` already excludes exponent notation, leading
 * zeros, a trailing bare `.`, and negative zero — the spellings a float would
 * arrive in.
 */
function isNonNegativeDecimal(value: string): boolean {
  return !value.startsWith("-") && decimalStringSchema.safeParse(value).success;
}

/**
 * Two canonical asset ids joined by `/`. No asset-id component may contain a
 * `/` (`@vigil/contracts`), which is what makes the split unambiguous. The
 * shape is restated rather than imported because `@vigil/market` owns
 * `instrumentIdSchema` and sits beside, not below, this package in the layer
 * graph; `candidates_instrument_id_canonical` restates it a third time in
 * SQL, where the database can enforce it.
 */
function isCanonicalInstrumentId(value: string): boolean {
  const halves = value.split("/");
  return halves.length === 2 && halves.every((half) => assetIdSchema.safeParse(half).success);
}

function isCandidateHorizon(value: string): value is CandidateHorizon {
  return CANDIDATE_HORIZONS.some((horizon) => horizon === value);
}

function isCandidateOutcome(value: string): value is CandidateOutcome {
  return CANDIDATE_OUTCOMES.some((outcome) => outcome === value);
}

/** The named fields that failed a check, for a diagnostic that says which. */
function namesOf(fields: ReadonlyArray<readonly [string, boolean]>): string {
  return fields
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(", ");
}

/**
 * The identity fields left blank, named. Blank is trimmed-empty, not just
 * `""`: a whitespace id reads as absent to every human looking at the
 * record and as present to every constraint.
 *
 * The value is refused, never trimmed into shape. These are keys the
 * producer will look the record back up by, and a store that silently
 * returned a different id than it was handed would be a worse bug than the
 * one it fixed.
 */
function blankFields(fields: ReadonlyArray<readonly [string, string]>): string {
  return namesOf(fields.map(([name, value]): readonly [string, boolean] => [name, value.trim() !== ""]));
}

type CandidateInstants = {
  readonly expiresAt: Date;
  readonly quoteAcquiredAt: Date;
  readonly quoteIngestedAt: Date;
  readonly generatedAt: Date;
  readonly recordedAt: Date;
};

type CandidatePreflight = { readonly outcome: "ok"; readonly instants: CandidateInstants } | DecisionRefusal;

/**
 * Reject, before any write, everything the tables would otherwise reject
 * obscurely — and the plan shape, which no single-row constraint can see at
 * all.
 */
function preflightCandidate(candidate: StoreCandidate): CandidatePreflight {
  const blank = blankFields([
    ["candidateId", candidate.candidateId],
    ["idempotencyKey", candidate.idempotencyKey],
    ["correlationId", candidate.correlationId],
    ["strategyId", candidate.strategyId],
    ["benchmarkId", candidate.benchmarkId],
    ["action", candidate.action],
  ]);
  if (blank !== "") {
    return refuse(
      "EMPTY_IDENTITY",
      `a candidate names itself, its delivery, its strategy, its benchmark and its action; ${blank} is blank`,
    );
  }

  const expiresAt = parseIsoInstant(candidate.expiresAt);
  const quoteAcquiredAt = parseIsoInstant(candidate.marketSnapshot.quoteAcquiredAt);
  const quoteIngestedAt = parseIsoInstant(candidate.marketSnapshot.ingestedAt);
  const generatedAt = parseIsoInstant(candidate.generatedAt);
  const recordedAt = parseIsoInstant(candidate.recordedAt);

  if (
    expiresAt === null ||
    quoteAcquiredAt === null ||
    quoteIngestedAt === null ||
    generatedAt === null ||
    recordedAt === null
  ) {
    const named = namesOf([
      ["expiresAt", expiresAt !== null],
      ["marketSnapshot.quoteAcquiredAt", quoteAcquiredAt !== null],
      ["marketSnapshot.ingestedAt", quoteIngestedAt !== null],
      ["generatedAt", generatedAt !== null],
      ["recordedAt", recordedAt !== null],
    ]);
    return refuse(
      "INVALID_TIMESTAMP",
      `candidate ${candidate.candidateId} carries ${named} that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }

  if (!isCanonicalInstrumentId(candidate.instrumentId)) {
    return refuse(
      "INVALID_INSTRUMENT",
      `candidate ${candidate.candidateId} names instrument ${candidate.instrumentId}, which is not two canonical asset ids joined by "/"`,
    );
  }

  if (!isCandidateHorizon(candidate.horizon)) {
    return refuse(
      "INVALID_HORIZON",
      `candidate ${candidate.candidateId} names horizon ${candidate.horizon}, which is not one of ${CANDIDATE_HORIZONS.join(", ")}`,
    );
  }

  const amounts: ReadonlyArray<readonly [string, string]> = [
    ["entryZoneMin", candidate.entryZoneMin],
    ["entryZoneMax", candidate.entryZoneMax],
    ["allowedExtension", candidate.allowedExtension],
    ["invalidationPrice", candidate.invalidationPrice],
    ["marketSnapshot.bidPrice", candidate.marketSnapshot.bidPrice],
    ["marketSnapshot.askPrice", candidate.marketSnapshot.askPrice],
    ...candidate.tranches.flatMap((tranche): ReadonlyArray<readonly [string, string]> => {
      const position = String(tranche.index);
      const quantity: readonly [string, string] = [`tranche ${position} quantity`, tranche.quantity];
      return tranche.triggerPrice === null
        ? [quantity]
        : [quantity, [`tranche ${position} triggerPrice`, tranche.triggerPrice]];
    }),
  ];
  const invalidAmount = amounts.find(([, value]) => !isNonNegativeDecimal(value));
  if (invalidAmount !== undefined) {
    return refuse(
      "INVALID_DECIMAL",
      `candidate ${candidate.candidateId} carries ${invalidAmount[0]} = ${invalidAmount[1]}, which is not a non-negative decimal string`,
    );
  }

  if (candidate.provenance.policyVersion.trim() === "" || candidate.provenance.strategyVersion.trim() === "") {
    return refuse(
      "MISSING_PROVENANCE",
      `candidate ${candidate.candidateId} does not name the policy and strategy versions that produced it`,
    );
  }

  if (candidate.tranches.length === 0) {
    return refuse("EMPTY_PLAN", `candidate ${candidate.candidateId} carries no position plan`);
  }

  // Sorted rather than compared in place: the caller may hand the tranches
  // over in any order, and what matters is that the set of indexes is
  // exactly 0..n-1 — which catches a gap, a repeat, and a negative index in
  // one rule, so the table's primary key and non-negative check never have
  // to answer for input this store accepted.
  const positions = candidate.tranches.map((tranche) => tranche.index).toSorted((left, right) => left - right);
  if (!positions.every((position, expected) => position === expected)) {
    return refuse(
      "INVALID_PLAN",
      `candidate ${candidate.candidateId} indexes its tranches ${positions.join(", ")}; a position plan is indexed 0..n-1`,
    );
  }

  return {
    outcome: "ok",
    instants: { expiresAt, quoteAcquiredAt, quoteIngestedAt, generatedAt, recordedAt },
  };
}

/**
 * Persist one candidate and its position plan, in one transaction. Either
 * the candidate and every tranche are durable or none of them are: a
 * candidate whose plan was half-written is a record of a decision nobody
 * made.
 *
 * Delivered twice with the same idempotency key, it records once.
 */
export async function recordCandidate(db: VigilDatabase, candidate: StoreCandidate): Promise<RecordCandidateResult> {
  const checked = preflightCandidate(candidate);
  if (checked.outcome === "refused") {
    return checked;
  }
  const { instants } = checked;

  return await db.transaction(async (tx): Promise<RecordCandidateResult> => {
    // No conflict target: the candidate id and the idempotency key are both
    // unique, and which one a redelivery collides with is exactly what the
    // lookup below tells apart.
    const inserted = await tx
      .insert(candidates)
      .values({
        candidateId: candidate.candidateId,
        idempotencyKey: candidate.idempotencyKey,
        correlationId: candidate.correlationId,
        strategyId: candidate.strategyId,
        instrumentId: candidate.instrumentId,
        action: candidate.action,
        actionDetail: candidate.actionDetail,
        horizon: candidate.horizon,
        entryZoneMin: candidate.entryZoneMin,
        entryZoneMax: candidate.entryZoneMax,
        allowedExtension: candidate.allowedExtension,
        invalidationPrice: candidate.invalidationPrice,
        invalidationConditions: [...candidate.invalidationConditions],
        expiresAt: instants.expiresAt,
        benchmarkId: candidate.benchmarkId,
        quoteAcquiredAt: instants.quoteAcquiredAt,
        quoteIngestedAt: instants.quoteIngestedAt,
        bidPrice: candidate.marketSnapshot.bidPrice,
        askPrice: candidate.marketSnapshot.askPrice,
        generatedAt: instants.generatedAt,
        recordedAt: instants.recordedAt,
        policyVersion: candidate.provenance.policyVersion,
        strategyVersion: candidate.provenance.strategyVersion,
        modelVersion: candidate.provenance.modelVersion,
        portfolioSnapshotVersion: candidate.provenance.portfolioSnapshotVersion,
        marketSnapshotVersion: candidate.provenance.marketSnapshotVersion,
      })
      .onConflictDoNothing()
      .returning({ candidateId: candidates.candidateId });

    if (inserted.length === 0) {
      const existing = await tx
        .select({ candidateId: candidates.candidateId })
        .from(candidates)
        .where(eq(candidates.idempotencyKey, candidate.idempotencyKey))
        .limit(1);
      const row = existing[0];
      if (row === undefined) {
        return refuse(
          "DUPLICATE_RECORD",
          `candidate id ${candidate.candidateId} is already stored under a different idempotency key; a regenerated candidate needs its own id`,
        );
      }
      return { outcome: "duplicate", candidateId: row.candidateId };
    }

    await tx.insert(candidateTranches).values(
      candidate.tranches.map((tranche) => ({
        candidateId: candidate.candidateId,
        trancheIndex: tranche.index,
        quantity: tranche.quantity,
        triggerPrice: tranche.triggerPrice,
      })),
    );

    return { outcome: "recorded", candidateId: candidate.candidateId };
  });
}

/**
 * The fields that make two writes the same plan.
 *
 * The terms only. A plan's identity is what a later gate will judge against
 * — the instrument the prices are denominated in, the band an entry may be
 * taken in, and the level the thesis is aiming at — so those four are
 * compared and a difference in any of them is refused.
 *
 * `formationReferenceMid`, the timestamps, the correlation id and the
 * provenance are deliberately not compared. They describe the write that
 * first recorded the plan rather than the terms it recorded, and a second
 * step of the same plan legitimately carries a different midpoint and a
 * different instant. Refusing on those would refuse the ordinary case; the
 * plan's formation figures are simply those of the write that formed it.
 */
function planTermsOf(plan: StorePositionPlan): ReadonlyArray<readonly [string, string]> {
  return [
    ["instrumentId", plan.instrumentId],
    ["entryZoneMin", plan.entryZoneMin],
    ["entryZoneMax", plan.entryZoneMax],
    ["thesisExitPrice", plan.thesisExitPrice],
  ];
}

/** Reject, before any write, everything the table would otherwise reject obscurely. */
function preflightPositionPlan(
  plan: StorePositionPlan,
): { readonly outcome: "ok"; readonly formedAt: Date; readonly recordedAt: Date } | DecisionRefusal {
  const blank = blankFields([
    ["positionPlanId", plan.positionPlanId],
    ["correlationId", plan.correlationId],
  ]);
  if (blank !== "") {
    return refuse("EMPTY_IDENTITY", `a position plan names itself and its correlation thread; ${blank} is blank`);
  }

  const formedAt = parseIsoInstant(plan.formedAt);
  const recordedAt = parseIsoInstant(plan.recordedAt);
  if (formedAt === null || recordedAt === null) {
    const named = namesOf([
      ["formedAt", formedAt !== null],
      ["recordedAt", recordedAt !== null],
    ]);
    return refuse(
      "INVALID_TIMESTAMP",
      `position plan ${plan.positionPlanId} carries ${named} that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }
  if (recordedAt.getTime() < formedAt.getTime()) {
    return refuse(
      "INVALID_TIMESTAMP",
      `position plan ${plan.positionPlanId} was recorded at ${plan.recordedAt}, before the ${plan.formedAt} its terms were set at`,
    );
  }

  if (!isCanonicalInstrumentId(plan.instrumentId)) {
    return refuse(
      "INVALID_INSTRUMENT",
      `position plan ${plan.positionPlanId} names instrument ${plan.instrumentId}, which is not two canonical asset ids joined by "/"`,
    );
  }

  const amounts: ReadonlyArray<readonly [string, string]> = [
    ["entryZoneMin", plan.entryZoneMin],
    ["entryZoneMax", plan.entryZoneMax],
    ["thesisExitPrice", plan.thesisExitPrice],
    ["formationReferenceMid", plan.formationReferenceMid],
  ];
  const invalid = amounts.find(([, value]) => !isNonNegativeDecimal(value));
  if (invalid !== undefined) {
    return refuse(
      "INVALID_DECIMAL",
      `position plan ${plan.positionPlanId} carries ${invalid[0]} = ${invalid[1]}, which is not a non-negative decimal string`,
    );
  }

  if (plan.provenance.policyVersion.trim() === "" || plan.provenance.strategyVersion.trim() === "") {
    return refuse(
      "MISSING_PROVENANCE",
      `position plan ${plan.positionPlanId} does not name the policy and strategy versions that produced it`,
    );
  }

  return { outcome: "ok", formedAt, recordedAt };
}

/**
 * Record the terms a staged plan's steps are authorized and revalidated
 * against, once, under the id an approved intent names.
 *
 * Record-once without a separate idempotency key: `position_plan_id` IS the
 * plan's identity, and a second key that always equalled it would be a
 * unique index guarding nothing. What a redelivery has to answer instead is
 * whether the terms are the same ones — so the stored row is compared field
 * by field, and a plan id arriving under different terms comes back as
 * `PLAN_TERMS_CONFLICT` rather than being quietly accepted under whichever
 * of the two the database happens to hold.
 *
 * That comparison cannot be a constraint. A check constraint sees one row,
 * and the question here is about the row already there; the
 * `position_plan_append_only_guard` trigger is the durable half — it makes
 * the stored terms unrewritable by any writer, including this one — and this
 * function is what turns an attempt to rewrite them into a reason code
 * instead of a driver error.
 */
export async function recordPositionPlan(
  db: VigilDatabase,
  plan: StorePositionPlan,
): Promise<RecordPositionPlanResult> {
  const checked = preflightPositionPlan(plan);
  if (checked.outcome === "refused") {
    return checked;
  }

  const inserted = await db
    .insert(positionPlans)
    .values({
      positionPlanId: plan.positionPlanId,
      correlationId: plan.correlationId,
      instrumentId: plan.instrumentId,
      entryZoneMin: plan.entryZoneMin,
      entryZoneMax: plan.entryZoneMax,
      thesisExitPrice: plan.thesisExitPrice,
      formationReferenceMid: plan.formationReferenceMid,
      formedAt: checked.formedAt,
      recordedAt: checked.recordedAt,
      policyVersion: plan.provenance.policyVersion,
      strategyVersion: plan.provenance.strategyVersion,
      modelVersion: plan.provenance.modelVersion,
      portfolioSnapshotVersion: plan.provenance.portfolioSnapshotVersion,
      marketSnapshotVersion: plan.provenance.marketSnapshotVersion,
    })
    .onConflictDoNothing({ target: positionPlans.positionPlanId })
    .returning({ positionPlanId: positionPlans.positionPlanId });

  if (inserted.length > 0) {
    return { outcome: "recorded", positionPlanId: plan.positionPlanId };
  }

  // The insert conflicted, so the id is taken. Read what it is taken by:
  // under READ COMMITTED this statement takes a fresh snapshot, so a plan a
  // concurrent transaction was still committing when the insert waited on it
  // is visible here.
  const stored = await loadPositionPlan(db, plan.positionPlanId);
  if (stored === null) {
    return refuse(
      "DUPLICATE_RECORD",
      `position plan id ${plan.positionPlanId} is taken by a row that cannot be read back; nothing was written`,
    );
  }

  const storedTerms = planTermsOf(stored);
  // Indexed against the same fixed field order both sides are built in, and
  // mapped BEFORE filtering: filtering first would renumber the survivors and
  // pair each difference with another field's stored value.
  const differing = planTermsOf(plan)
    .map(([name, value], index): string | null => {
      const held = storedTerms[index];
      return held !== undefined && held[1] === value
        ? null
        : `${name} ${value} against the stored ${held?.[1] ?? "nothing"}`;
    })
    .filter((message): message is string => message !== null);

  if (differing.length > 0) {
    return refuse(
      "PLAN_TERMS_CONFLICT",
      `position plan ${plan.positionPlanId} is already stored under different terms (${differing.join("; ")}); a plan's terms are what a later dispatch is revalidated against and are never rewritten`,
    );
  }

  return { outcome: "duplicate", positionPlanId: stored.positionPlanId };
}

/**
 * The terms one approved intent's dispatch must be revalidated against, read
 * back from durable history; `null` when no plan is stored under that id.
 *
 * `null` is a real answer rather than an error: `approved_intents` carries no
 * foreign key into this table yet, so an authorization can name a plan
 * nobody recorded, and the execution runtime refuses such a dispatch rather
 * than inventing terms for it.
 */
export async function loadPositionPlan(
  db: VigilDatabase,
  positionPlanId: string,
): Promise<StoredPositionPlan | null> {
  const rows = await db
    .select()
    .from(positionPlans)
    .where(eq(positionPlans.positionPlanId, positionPlanId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    positionPlanId: row.positionPlanId,
    correlationId: row.correlationId,
    instrumentId: row.instrumentId,
    entryZoneMin: row.entryZoneMin,
    entryZoneMax: row.entryZoneMax,
    thesisExitPrice: row.thesisExitPrice,
    formationReferenceMid: row.formationReferenceMid,
    formedAt: row.formedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    provenance: {
      policyVersion: row.policyVersion,
      strategyVersion: row.strategyVersion,
      modelVersion: row.modelVersion,
      portfolioSnapshotVersion: row.portfolioSnapshotVersion,
      marketSnapshotVersion: row.marketSnapshotVersion,
    },
  };
}

/**
 * Persist one judgement about a candidate.
 *
 * The candidate's existence is not checked and then written against — it is
 * the foreign key that answers, so there is no window between the check and
 * the insert. A failed insert takes the whole statement with it, which is
 * what makes "an outcome for a candidate nobody recorded writes nothing"
 * true rather than merely intended.
 */
export async function recordCandidateEvaluation(
  db: VigilDatabase,
  evaluation: StoreCandidateEvaluation,
): Promise<RecordEvaluationResult> {
  const blank = blankFields([
    ["evaluationId", evaluation.evaluationId],
    ["idempotencyKey", evaluation.idempotencyKey],
  ]);
  if (blank !== "") {
    return refuse("EMPTY_IDENTITY", `an evaluation names itself and its delivery; ${blank} is blank`);
  }

  const evaluatedAt = parseIsoInstant(evaluation.evaluatedAt);
  const recordedAt = parseIsoInstant(evaluation.recordedAt);
  const quoteAcquiredAt =
    evaluation.quoteAcquiredAt === null ? null : parseIsoInstant(evaluation.quoteAcquiredAt);

  if (evaluatedAt === null || recordedAt === null || (evaluation.quoteAcquiredAt !== null && quoteAcquiredAt === null)) {
    const named = namesOf([
      ["evaluatedAt", evaluatedAt !== null],
      ["recordedAt", recordedAt !== null],
      ["quoteAcquiredAt", evaluation.quoteAcquiredAt === null || quoteAcquiredAt !== null],
    ]);
    return refuse(
      "INVALID_TIMESTAMP",
      `evaluation ${evaluation.evaluationId} carries ${named} that is not an ISO-8601 UTC instant on a real calendar day`,
    );
  }

  if (!isCandidateOutcome(evaluation.outcome)) {
    return refuse(
      "INVALID_OUTCOME",
      `evaluation ${evaluation.evaluationId} names outcome ${evaluation.outcome}, which is not one of ${CANDIDATE_OUTCOMES.join(", ")}`,
    );
  }

  if (evaluation.reasonCode !== null && !reasonCodeSchema.safeParse(evaluation.reasonCode).success) {
    return refuse(
      "INVALID_REASON_CODE",
      `evaluation ${evaluation.evaluationId} names reason code ${evaluation.reasonCode}, which is not in the REASON_CODES registry (docs/policy.md)`,
    );
  }

  if (evaluation.executablePrice !== null && !isNonNegativeDecimal(evaluation.executablePrice)) {
    return refuse(
      "INVALID_DECIMAL",
      `evaluation ${evaluation.evaluationId} carries executablePrice = ${evaluation.executablePrice}, which is not a non-negative decimal string`,
    );
  }

  try {
    const inserted = await db
      .insert(candidateEvaluations)
      .values({
        evaluationId: evaluation.evaluationId,
        idempotencyKey: evaluation.idempotencyKey,
        candidateId: evaluation.candidateId,
        outcome: evaluation.outcome,
        reasonCode: evaluation.reasonCode,
        detail: evaluation.detail,
        executablePrice: evaluation.executablePrice,
        quoteAcquiredAt,
        evaluatedAt,
        recordedAt,
      })
      .onConflictDoNothing()
      .returning({ evaluationId: candidateEvaluations.evaluationId });

    const row = inserted[0];
    if (row !== undefined) {
      return { outcome: "recorded", evaluationId: row.evaluationId };
    }

    const existing = await db
      .select({ evaluationId: candidateEvaluations.evaluationId })
      .from(candidateEvaluations)
      .where(eq(candidateEvaluations.idempotencyKey, evaluation.idempotencyKey))
      .limit(1);
    const duplicate = existing[0];
    if (duplicate === undefined) {
      return refuse(
        "DUPLICATE_RECORD",
        `evaluation id ${evaluation.evaluationId} is already stored under a different idempotency key; a re-run evaluation needs its own id`,
      );
    }
    return { outcome: "duplicate", evaluationId: duplicate.evaluationId };
  } catch (error) {
    if (
      postgresErrorCode(error) === PG_FOREIGN_KEY_VIOLATION &&
      postgresConstraintName(error) === "candidate_evaluations_candidate_id_fk"
    ) {
      return refuse(
        "UNKNOWN_CANDIDATE",
        `candidate ${evaluation.candidateId} is not in durable history, so there is no candidate this outcome could belong to`,
      );
    }
    throw error;
  }
}

function toStoreEvaluation(row: typeof candidateEvaluations.$inferSelect): StoreCandidateEvaluation {
  return {
    evaluationId: row.evaluationId,
    idempotencyKey: row.idempotencyKey,
    candidateId: row.candidateId,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    detail: row.detail,
    executablePrice: row.executablePrice,
    quoteAcquiredAt: row.quoteAcquiredAt === null ? null : row.quoteAcquiredAt.toISOString(),
    evaluatedAt: row.evaluatedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

/**
 * Every candidate, newest `generatedAt` first, each with its plan in index
 * order and the newest judgement made about it.
 *
 * The newest evaluation is picked by the database with `DISTINCT ON` rather
 * than by reading every evaluation and folding them in memory: evaluations
 * accumulate for as long as a candidate is watched, and a dashboard that
 * loaded all of them to display one would get slower every hour it ran.
 * Ties on `evaluatedAt` break on `recordedAt` and then on the id, so the row
 * this returns is the same row on every call rather than whichever the scan
 * reached first.
 */
export async function loadCandidates(db: VigilDatabase): Promise<readonly StoredCandidate[]> {
  const candidateRows = await db
    .select()
    .from(candidates)
    .orderBy(desc(candidates.generatedAt), asc(candidates.candidateId));

  if (candidateRows.length === 0) {
    return [];
  }

  const trancheRows = await db
    .select()
    .from(candidateTranches)
    .orderBy(asc(candidateTranches.candidateId), asc(candidateTranches.trancheIndex));

  const latestRows = await db
    .selectDistinctOn([candidateEvaluations.candidateId])
    .from(candidateEvaluations)
    .orderBy(
      asc(candidateEvaluations.candidateId),
      desc(candidateEvaluations.evaluatedAt),
      desc(candidateEvaluations.recordedAt),
      desc(candidateEvaluations.evaluationId),
    );

  const tranchesByCandidate = new Map<string, StoreTranche[]>();
  for (const row of trancheRows) {
    const plan = tranchesByCandidate.get(row.candidateId) ?? [];
    plan.push({ index: row.trancheIndex, quantity: row.quantity, triggerPrice: row.triggerPrice });
    tranchesByCandidate.set(row.candidateId, plan);
  }

  const latestByCandidate = new Map<string, StoreCandidateEvaluation>();
  for (const row of latestRows) {
    latestByCandidate.set(row.candidateId, toStoreEvaluation(row));
  }

  return candidateRows.map((row) => ({
    candidateId: row.candidateId,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    strategyId: row.strategyId,
    instrumentId: row.instrumentId,
    action: row.action,
    actionDetail: row.actionDetail,
    horizon: row.horizon,
    entryZoneMin: row.entryZoneMin,
    entryZoneMax: row.entryZoneMax,
    allowedExtension: row.allowedExtension,
    invalidationPrice: row.invalidationPrice,
    invalidationConditions: row.invalidationConditions,
    expiresAt: row.expiresAt.toISOString(),
    benchmarkId: row.benchmarkId,
    marketSnapshot: {
      quoteAcquiredAt: row.quoteAcquiredAt.toISOString(),
      ingestedAt: row.quoteIngestedAt.toISOString(),
      bidPrice: row.bidPrice,
      askPrice: row.askPrice,
    },
    generatedAt: row.generatedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    provenance: {
      policyVersion: row.policyVersion,
      strategyVersion: row.strategyVersion,
      modelVersion: row.modelVersion,
      portfolioSnapshotVersion: row.portfolioSnapshotVersion,
      marketSnapshotVersion: row.marketSnapshotVersion,
    },
    tranches: tranchesByCandidate.get(row.candidateId) ?? [],
    latestEvaluation: latestByCandidate.get(row.candidateId) ?? null,
  }));
}
