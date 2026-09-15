import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The `decisions` record family: what this application decided, recorded
 * **before** the outcome is known (`docs/architecture.md` "Record families";
 * `docs/evaluation.md` "Opportunity journal"). Candidates, the staged plans
 * they are worked through, and the evaluations that later judge them land
 * here; the theses and research proposals that sit above a candidate arrive
 * with the research slice that produces them.
 *
 * A staged plan is two records rather than one, because two different
 * readers need two different halves of it. `candidate_tranches` holds the
 * **staging** — how much is bought at which trigger, hanging off the
 * candidate that proposed it. `position_plans` holds the **terms** — the
 * entry band and the thesis exit price, under the id an approved intent
 * names — because the pre-dispatch gate in `apps/trading` re-measures the
 * economics against them at every dispatch and cannot reach the candidate's
 * staging to do it. Neither table restates the other.
 *
 * Three schema decisions carry the invariants this family exists for, and
 * each is a database constraint rather than an application convention:
 *
 * 1. **An outcome cannot exist without its candidate.** `candidate_id` on
 *    `candidate_evaluations` is `NOT NULL` with a foreign key into
 *    `candidates`, so an evaluation has nowhere to point unless the
 *    candidate it judges was persisted first. That is the durable half of
 *    "every generated candidate is logged before any outcome is known" — an
 *    application that wrote the outcome first would be refused by the
 *    database rather than quietly producing an opportunity journal that only
 *    contains the trades that worked.
 * 2. **No floating point anywhere.** Prices and quantities here are decision
 *    data rather than ledger movements — nothing in this package adds them
 *    up — so they are stored as text decimal strings, with a check
 *    constraint restating `@vigil/contracts`' decimal-string shape so a
 *    `toFixed()` result, an exponent, or a `NaN` has nowhere to land. Base
 *    units and `asset_scale` belong to the journal, which is where the
 *    arithmetic happens.
 * 3. **A candidate is immutable once written.** The staged plan, entry zone,
 *    and invalidation price are the record of what was believed before the
 *    price moved; a trigger (see the `candidate_append_only_guard`
 *    migration) rejects every `UPDATE` and `DELETE` against a candidate and
 *    its tranches, so "a missed entry is WAIT or MISSED, never a rewritten
 *    BUY" (`AGENTS.md`) is a property of the database. A later judgement is
 *    a new `candidate_evaluations` row, never an edit to the candidate.
 *
 * Timestamps are `timestamptz(3)`, matching what an ISO-8601 timestamp
 * carries, so a stored instant is one the application can read back and
 * replay exactly.
 */

/**
 * The canonical asset-id body from `@vigil/contracts`
 * (`chainId|kind|value|withdrawalNetwork`), as a Postgres ARE fragment. A
 * Postgres constraint cannot import a TypeScript regex, so the shape is
 * restated here exactly as `asset_scales` already restates it, and
 * `decision-store.ts` validates the same value against `assetIdSchema` at
 * the boundary so this constraint is the second line of defence rather than
 * the first. Bracket expressions (`[|]`, `[.]`) rather than backslash
 * escapes: the SQL below is a plain string literal, and a backslash in one
 * is a literal backslash under `standard_conforming_strings`.
 */
const CANONICAL_ASSET_ID = "[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+";

/**
 * A canonical instrument id is two canonical asset ids joined by `/` —
 * `@vigil/market`'s `canonicalInstrumentId` shape. No asset-id component may
 * contain `/`, which is what lets the two halves be told apart at all. This
 * package sits below `@vigil/market` in the layer graph and cannot import
 * that schema, so the shape is restated rather than referenced.
 */
const CANONICAL_INSTRUMENT_ID = `^${CANONICAL_ASSET_ID}/${CANONICAL_ASSET_ID}$`;

/**
 * `@vigil/contracts`' `DECIMAL_STRING_PATTERN` without its optional leading
 * `-`: every amount this family stores is a price, a quantity, or a distance
 * between two prices, none of which is ever negative. No exponent notation,
 * no leading `+`, no leading zeros, no trailing bare `.`, no whitespace —
 * each of those is a way float syntax or a formatting artifact reaches a
 * column (`docs/resilience.md`).
 */
const NON_NEGATIVE_DECIMAL = "^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$";

function decimalShape(column: string): string {
  return `${column} ~ '${NON_NEGATIVE_DECIMAL}'`;
}

function nullableDecimalShape(column: string): string {
  return `(${column} is null or ${decimalShape(column)})`;
}

/**
 * How long the candidate is meant to be held if it is entered — the
 * `TradeProposal` horizon vocabulary (`docs/architecture.md` "Contracts").
 * A Postgres enum rather than free text because this slice owns the
 * vocabulary: a column that could hold a fourth horizon nobody defined is a
 * column a later comparison cannot group by.
 */
export const candidateHorizonEnum = pgEnum("candidate_horizon", ["intraday", "swing", "position"]);

/**
 * What an evaluation concluded about a candidate. `MISSED` and `WAIT` are
 * deliberately distinct values rather than one "not entered" state: a
 * deliberate wait and an entry the application was too slow to take are
 * different findings (`docs/evaluation.md` "Counterfactuals and missed
 * opportunities"), and collapsing them would erase the distinction the
 * opportunity journal exists to measure.
 */
export const candidateOutcomeEnum = pgEnum("candidate_outcome", ["ENTRY_ELIGIBLE", "WAIT", "MISSED", "BLOCKED"]);

export const candidates = pgTable(
  "candidates",
  {
    candidateId: text("candidate_id").primaryKey(),
    /** The same generated candidate delivered twice is stored once. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Ties the candidate to its evaluations, intent, and eventual outcome. */
    correlationId: text("correlation_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    /** `baseAssetId/quoteAssetId`, both canonical — never a ticker pair. */
    instrumentId: text("instrument_id").notNull(),
    /** The `TradeProposal` action vocabulary; `BUY` is the only one produced today. */
    action: text("action").notNull(),
    /** Preserves MISSED_ENTRY / WAIT as distinct from a plain WAIT downstream. */
    actionDetail: text("action_detail").notNull(),
    horizon: candidateHorizonEnum("horizon").notNull(),
    entryZoneMin: text("entry_zone_min").notNull(),
    entryZoneMax: text("entry_zone_max").notNull(),
    /** Price distance above `entry_zone_max` that still counts as WAIT rather than MISSED. */
    allowedExtension: text("allowed_extension").notNull(),
    /** An executable price below this invalidates the thesis outright. */
    invalidationPrice: text("invalidation_price").notNull(),
    /** The named conditions that would invalidate the thesis, as written when it was formed. */
    invalidationConditions: text("invalidation_conditions").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** What this candidate is measured against (`docs/evaluation.md` "Comparison baselines"). */
    benchmarkId: text("benchmark_id").notNull(),
    /**
     * The quote the candidate was generated from, kept as the two timestamp
     * stages that make it replayable — acquisition and ingestion — beside the
     * two prices themselves. Without them a later reader cannot tell whether
     * the decision was made on a fresh quote or a stale one.
     */
    quoteAcquiredAt: timestamp("quote_acquired_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    quoteIngestedAt: timestamp("quote_ingested_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    bidPrice: text("bid_price").notNull(),
    askPrice: text("ask_price").notNull(),
    /** The analysis-completion stage of the timestamp family. */
    generatedAt: timestamp("generated_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote it down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /**
     * What produced this record. A candidate is the unit a later comparison
     * attributes an outcome to, so without the versions that generated it no
     * comparison between two behaviors means anything (`AGENTS.md`,
     * "Architecture and implementation").
     */
    policyVersion: text("policy_version").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    /** Null when no LLM was involved — every deterministic path today. */
    modelVersion: text("model_version"),
    /** Null when no portfolio snapshot informed the candidate. */
    portfolioSnapshotVersion: text("portfolio_snapshot_version"),
    /** Null when no market snapshot version informed it. */
    marketSnapshotVersion: text("market_snapshot_version"),
  },
  (table) => [
    uniqueIndex("candidates_idempotency_key_key").on(table.idempotencyKey),
    // Deliberately not unique: one correlation id ties a candidate, its
    // evaluations, and its intent together, so it is indexed for lookup and
    // nothing more.
    index("candidates_correlation_id_idx").on(table.correlationId),
    index("candidates_generated_at_idx").on(table.generatedAt),
    check("candidates_instrument_id_canonical", sql.raw(`instrument_id ~ '${CANONICAL_INSTRUMENT_ID}'`)),
    check(
      "candidates_prices_decimal",
      sql.raw(
        [
          decimalShape("entry_zone_min"),
          decimalShape("entry_zone_max"),
          decimalShape("allowed_extension"),
          decimalShape("invalidation_price"),
          decimalShape("bid_price"),
          decimalShape("ask_price"),
        ].join(" and "),
      ),
    ),
    check(
      "candidates_provenance_present",
      sql`length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0`,
    ),
  ],
);

/**
 * The staged position plan for one candidate: what would be bought, in what
 * order, and at what trigger.
 *
 * A child table rather than a JSON column because the plan is read back
 * tranche by tranche and each tranche carries a quantity — a money-shaped
 * value that the `decimal` check below has to be able to reach. A JSON blob
 * would put every quantity beyond the reach of any constraint.
 *
 * `trigger_price` is null for a tranche that enters at the candidate's own
 * entry zone rather than at a level of its own.
 */
export const candidateTranches = pgTable(
  "candidate_tranches",
  {
    candidateId: text("candidate_id").notNull(),
    /** Position in the plan, contiguous from 0; the order the tranches are worked. */
    trancheIndex: integer("tranche_index").notNull(),
    quantity: text("quantity").notNull(),
    triggerPrice: text("trigger_price"),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.trancheIndex] }),
    foreignKey({
      columns: [table.candidateId],
      foreignColumns: [candidates.candidateId],
      name: "candidate_tranches_candidate_id_fk",
    }),
    check("candidate_tranches_index_non_negative", sql`tranche_index >= 0`),
    check(
      "candidate_tranches_amounts_decimal",
      sql.raw(`${decimalShape("quantity")} and ${nullableDecimalShape("trigger_price")}`),
    ),
  ],
);

/**
 * The durable terms of a staged position plan: the thesis the plan is
 * executing toward, and the price band its steps may be entered in.
 *
 * `approved_intents.position_plan_id` names this record ("the staged plan
 * this intent executes a step of"). It exists because the pre-dispatch
 * economic revalidation in `apps/trading` needs two figures the
 * authorization itself does not carry — the entry zone the approval was
 * granted within, and the exit price gross edge is measured against — and
 * a process that restarts between approval and dispatch has no memory to
 * read them out of. `approved_intents` stores the *result* of the approval
 * (the gross, the cost breakdown, the hurdle); these are the terms that
 * result was derived from, and they outlive the process that derived it.
 *
 * ## Terms, not staging
 *
 * This table deliberately does **not** mirror `@vigil/strategies`'
 * `PositionPlan`, which is a total quantity split into indexed tranches at
 * trigger prices. That staging is already durable as `candidate_tranches`,
 * hanging off the candidate whose thesis produced it, and a second durable
 * home for the same split would be two records that can disagree about how
 * much is bought at what price — with nothing to say which one the
 * execution path should believe. What the execution path cannot get
 * anywhere else is the *terms*, so the terms are what lives here.
 *
 * ## Immutable, and why that matters more here than elsewhere
 *
 * The `position_plan_append_only_guard` migration rejects every `UPDATE`
 * and `DELETE`, for the reason `candidates` is guarded: these prices are
 * what an authorization was granted against. A plan whose entry zone or
 * exit price could be edited after approval would let the gate that decides
 * whether to spend be re-aimed after the fact — the authorization rewritten
 * through a column rather than through a new intent.
 *
 * A plan is recorded once, under the id the intent names, and a second
 * approval naming the same plan carries the same terms or is refused; the
 * store's `recordPositionPlan` draws that line, because no single-row
 * constraint can compare a write against the row already there.
 *
 * `formation_reference_mid` is **evidence, never an input**. It says what
 * the midpoint was when these terms were set, which is the only thing that
 * makes `thesis_exit_price` interpretable later — a 260.00 target is a
 * different claim against a 250.05 mid than against a 259.00 one. Nothing
 * in the pre-dispatch gate reads it, and nothing may: gross edge at
 * dispatch is measured from the FRESH midpoint, and measuring it from this
 * one would freeze the per-unit edge at approval, where it would clear its
 * hurdle forever however far the market had since moved. That is precisely
 * the decay this application refuses to trade through.
 *
 * It is a **plan-level** figure, and that is a cardinality judgement rather
 * than a convenience. One plan is executed by one intent per step, each
 * approved at its own midpoint; a per-approval market measurement stored on
 * the shared row would either refuse the second step or silently keep the
 * first one's number. So this column records the midpoint the terms were
 * set at, once, and a step's own approval-time figure stays with that step.
 *
 * Which leaves it derivable rather than stored, to a stated tolerance:
 * `approved_intents.expected_gross_base` is the per-unit edge times the
 * quantity, floored, so dividing it back by `quantity_base` recovers the
 * per-unit edge — and with `thesis_exit_price` above, the approval-time
 * midpoint — to within `10^quantity_scale / quantity_units` of a numeraire
 * base unit. That is one base unit at a whole unit of quantity, ten at a
 * tenth of one, and it widens as the step shrinks, which is the direction a
 * staged plan moves. Nothing reads either figure today; a later evaluation
 * that needs the exact per-step midpoint should store it on the intent
 * rather than sharpen the division.
 *
 * ## The split holds for a staged plan rather than merely surviving one
 *
 * Every step of one plan is entered in the same band, toward the same
 * target — the tranches differ in size and trigger, which is
 * `candidate_tranches`' half. So a second step's approval arrives with
 * terms identical to the first's and `recordPositionPlan` answers
 * `duplicate`, not `PLAN_TERMS_CONFLICT`. The conflict is reserved for what
 * it is meant to catch: two different theses claiming one plan id.
 *
 * There is no `candidate_id` here. The candidate a plan came from is
 * already on the intent that executes it, and the correlation id below is
 * what `docs/resilience.md` §10 threads a plan, its intents, its attempts
 * and its postings together with.
 */
export const positionPlans = pgTable(
  "position_plans",
  {
    /** The id `approved_intents.position_plan_id` names. */
    positionPlanId: text("position_plan_id").primaryKey(),
    /** Ties the plan to the intents, holds, attempts and postings that execute it. */
    correlationId: text("correlation_id").notNull(),
    /**
     * `baseAssetId/quoteAssetId`, both canonical. Every price below is in
     * the quote asset, and without the pair naming which one that is they
     * are numbers in no currency — a plan read back by a restarted process
     * could then supply another instrument's entry zone to this one's gate.
     */
    instrumentId: text("instrument_id").notNull(),
    /** The band a step of this plan may be entered in; the allocator never extends it. */
    entryZoneMin: text("entry_zone_min").notNull(),
    entryZoneMax: text("entry_zone_max").notNull(),
    /**
     * The price the thesis expects this position to be worth. Fixed by the
     * thesis rather than by the market, which is what makes it safe to
     * store: the freshest midpoint is measured against it at every dispatch,
     * so a mid that rises toward it shrinks the gross edge exactly as it
     * should.
     */
    thesisExitPrice: text("thesis_exit_price").notNull(),
    /**
     * The midpoint these terms were set against, recorded once with them.
     * Evidence and never a dispatch-time input, and plan-level rather than
     * per-approval — the header gives both reasons, and the tolerance a
     * per-step midpoint is derivable to instead.
     */
    formationReferenceMid: text("formation_reference_mid").notNull(),
    /** When the terms were set; the analysis-completion stage of the timestamp family. */
    formedAt: timestamp("formed_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote them down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /**
     * What produced these terms. Shaped exactly like `candidates`' own
     * provenance, including which two are nullable: a plan formed without a
     * portfolio or market snapshot version is a plan nothing snapshotted,
     * and a blank string there would claim one that never existed.
     */
    policyVersion: text("policy_version").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    /** Null when no LLM was involved — every deterministic path today. */
    modelVersion: text("model_version"),
    portfolioSnapshotVersion: text("portfolio_snapshot_version"),
    marketSnapshotVersion: text("market_snapshot_version"),
  },
  (table) => [
    // Deliberately not unique: one correlation id ties a plan to the
    // intents that execute its steps.
    index("position_plans_correlation_id_idx").on(table.correlationId),
    check("position_plans_instrument_id_canonical", sql.raw(`instrument_id ~ '${CANONICAL_INSTRUMENT_ID}'`)),
    check(
      "position_plans_prices_decimal",
      sql.raw(
        [
          decimalShape("entry_zone_min"),
          decimalShape("entry_zone_max"),
          decimalShape("thesis_exit_price"),
          decimalShape("formation_reference_mid"),
        ].join(" and "),
      ),
    ),
    // A blank id satisfies NOT NULL and makes a perfectly good primary key,
    // which is how every unnamed plan ends up sharing one row.
    check(
      "position_plans_identity_present",
      sql`length(btrim(position_plan_id)) > 0 and length(btrim(correlation_id)) > 0`,
    ),
    check(
      "position_plans_provenance_present",
      sql`length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0`,
    ),
    // Terms cannot be written down before they were set.
    check("position_plans_recorded_after_formation", sql`recorded_at >= formed_at`),
    // `entry_zone_min <= entry_zone_max` is deliberately NOT restated here.
    // These columns hold decimal TEXT, where `<=` compares lexicographically
    // and would call 9.00 greater than 10.00 — a constraint that is wrong
    // more often than the input it would catch. The ordering rule belongs to
    // `@vigil/policy`'s `entryZoneSchema`, which refines it at both the
    // approval and the pre-dispatch gate, so an inverted zone refuses every
    // dispatch rather than passing one.
  ],
);

/**
 * What was concluded about a candidate, at one point in time.
 *
 * Evaluations accumulate: a candidate judged WAIT at one quote and MISSED an
 * hour later has two rows, and the reader takes the newest by `evaluated_at`.
 * That is why a correction here is an appended row rather than an edit, and
 * why this table carries no correlation id or provenance of its own — it
 * inherits both from the candidate its `NOT NULL` foreign key points at,
 * which cannot be absent.
 */
export const candidateEvaluations = pgTable(
  "candidate_evaluations",
  {
    evaluationId: text("evaluation_id").primaryKey(),
    /** The same evaluation delivered twice is stored once. */
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * The candidate this outcome belongs to. `NOT NULL` plus the foreign key
     * below is the durable form of "every generated candidate is persisted
     * before any outcome is known": an outcome for a candidate nobody wrote
     * down has nowhere to point.
     */
    candidateId: text("candidate_id").notNull(),
    outcome: candidateOutcomeEnum("outcome").notNull(),
    /**
     * A `REASON_CODES` member (`docs/policy.md` "Reason codes") or null when
     * the outcome needs no refusal reason. Text rather than a Postgres enum
     * because `@vigil/contracts` owns that vocabulary; forking it into SQL
     * would give this application two registries that can disagree silently.
     * `decision-store.ts` validates the value against the registry at the
     * boundary.
     */
    reasonCode: text("reason_code"),
    detail: text("detail").notNull(),
    /** Null when the outcome was reached without a usable executable price. */
    executablePrice: text("executable_price"),
    /**
     * When the quote behind this judgement was acquired, or null when there
     * was no quote to age. Deliberately not paired with `executable_price`
     * in either direction, and nothing enforces a pairing: a fresh quote
     * against an empty book has an acquisition time and no executable price,
     * and which combination is meaningful is the evaluating strategy's
     * judgement to record, not this table's to police.
     */
    quoteAcquiredAt: timestamp("quote_acquired_at", { withTimezone: true, precision: 3, mode: "date" }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("candidate_evaluations_idempotency_key_key").on(table.idempotencyKey),
    // The index the "newest evaluation per candidate" read walks.
    index("candidate_evaluations_candidate_id_evaluated_at_idx").on(table.candidateId, table.evaluatedAt),
    foreignKey({
      columns: [table.candidateId],
      foreignColumns: [candidates.candidateId],
      name: "candidate_evaluations_candidate_id_fk",
    }),
    check(
      "candidate_evaluations_executable_price_decimal",
      sql.raw(nullableDecimalShape("executable_price")),
    ),
  ],
);
