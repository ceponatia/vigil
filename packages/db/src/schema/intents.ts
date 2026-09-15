import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { candidates } from "./decisions";
import { assetScales, BASE_UNIT_PRECISION, journalEntries, MAX_ASSET_SCALE } from "./journal";

/**
 * The `intents` record family: capital authority and durable dispatch
 * (`docs/architecture.md` "Record families"). Four tables, in the order
 * money moves through them: an approved intent authorizes a spend, a
 * reservation holds the capital for it, an execution attempt is one
 * versioned try at consuming that authorization, and an outbox row is the
 * durable record written **before** anything is handed to a venue.
 *
 * Every invariant below is a database constraint rather than an application
 * convention, because the application must not be trusted to hold them on
 * its own: a duplicated proposal, a racing retry, and a crashed dispatcher
 * are all ordinary events, and each of them is a way to authorize a second
 * spend if only the calling code stands in the way.
 *
 * ## An approved intent is immutable, and consumable exactly once
 *
 * `ApprovedEconomicIntent` is documented as "immutable once approved,
 * consumable exactly once economically" (`docs/architecture.md`
 * "Contracts"). Both halves are enforced, and deliberately in different
 * places:
 *
 * - **Immutable** — the `intent_lifecycle_guards` migration's trigger
 *   rejects every `UPDATE` and `DELETE` against `approved_intents`, the
 *   same append-only shape the journal and the candidates already use.
 *   Full append-only rather than a guard over a list of "authorizing"
 *   columns: a column list has to be maintained, and the column a later
 *   slice forgets to add to it is exactly the one that becomes quietly
 *   mutable. It costs nothing here because an intent carries no lifecycle
 *   of its own — the lifecycle lives on its attempts, whose whole purpose
 *   is to change state.
 * - **Consumable once** — a partial unique index over `intent_id` on
 *   `execution_attempts` where `spent_base > 0`. At most one attempt on an
 *   intent may ever record a spend, so a second attempt that moved money
 *   has nowhere to be written. The guard trigger closes the other half of
 *   the same door: a *new* attempt may not be opened on an intent that some
 *   earlier attempt already consumed, which is what stops the second
 *   dispatch from happening at all rather than merely being unrecordable
 *   after the fact.
 *
 * A remainder after a partial fill is therefore a **new intent**, not a
 * further attempt on this one. That follows from the contract's own words:
 * spending more against an authorization that has already been consumed is
 * a second consumption, whatever it is called, and a new authorization is
 * exactly the audit trail that case deserves.
 *
 * ## A retry is a versioned attempt, never a new authorization
 *
 * `(intent_id, attempt)` is unique on both `reservations` and
 * `execution_attempts`, so an attempt number always names exactly one
 * authorization to act. Two partial unique indexes carry what that
 * uniqueness alone cannot:
 *
 * - **one live hold per intent** (`reservations`, `state = 'active'`) —
 *   nothing in `(intent_id, attempt)` requires the previous attempt to be
 *   finished, so a caller that timed out and retried under attempt 2 would
 *   hold the funds twice while attempt 1 is still live.
 * - **one live attempt per intent** (`execution_attempts`, every state that
 *   is not terminal) — the same defect one layer up, and the place
 *   `docs/resilience.md` §3's "reconciliation precedes resubmission"
 *   becomes a property of the database: `UNKNOWN` is one of the states the
 *   index counts as live, so attempt 2 cannot be opened while attempt 1's
 *   fate is unknown. That is the entire point of UNKNOWN being a state
 *   rather than a failure, and an index is the only form of it a racing
 *   caller cannot skip.
 *
 * ## Persistence before action
 *
 * `docs/resilience.md` §9: "Intent and reservation are persisted before
 * submission. Dispatch goes through a durable outbox. If a durable record
 * cannot be written, no new economic action proceeds." That ordering is a
 * chain of `NOT NULL` foreign keys — an outbox row points at an execution
 * attempt, which points at an approved intent — so a dispatch record for an
 * attempt nobody opened, or an attempt on an authorization nobody wrote
 * down, has nowhere to point. The guard trigger adds the part a foreign key
 * cannot say: a new attempt must be born in `SUBMITTING` with nothing spent
 * and nothing received, and a new outbox row must be born `pending`. A row
 * inserted already `dispatched` would be a dispatch that was never durable
 * beforehand, which is the failure §9 exists to prevent.
 *
 * ## What this family deliberately does not carry
 *
 * - **No credential, key, seed, or signing material**, in any column, ever
 *   (`AGENTS.md` "Database changes"). The outbox carries a `payload_digest`
 *   — a SHA-256 hex digest of what will be dispatched, constrained to that
 *   shape — so a resumed dispatcher can prove the payload it is about to
 *   send is the one that was authorized, without the payload itself being
 *   stored here.
 * - **No per-fill detail.** An execution attempt is the intent-side record
 *   of one try at consuming an authorization: which attempt, what state,
 *   how much of the authorization it actually consumed. The venue's own
 *   order object, its events, and its individual fills are the `orders`
 *   record family, which arrives with the slice that needs them and will
 *   reference the attempt.
 * - **No `rejection_reason_code`.** The `ApprovedEconomicIntent` contract
 *   names one, but a row in `approved_intents` exists only because policy
 *   approved: a non-null rejection code on one would mean the table holds
 *   an authorization policy refused. A refusal is a `candidate_evaluations`
 *   row with a `BLOCKED` outcome and a reason code from `docs/policy.md`,
 *   in the `decisions` family that already owns decisions-including-refusals.
 * - **No `reserved_assets` column.** The contract's `reservedAssets` array
 *   is the `reservations` rows that name this `intent_id`; a second copy on
 *   the intent would be a list that can disagree with the holds actually
 *   taken.
 */

/**
 * A reservation is the durable record that capital is committed to one
 * intent, written **before** anything acts on it (`docs/resilience.md` §9).
 * Beside the two unique constraints the family header explains, it carries
 * two of its own:
 *
 * - `idempotency_key` — the same reservation request delivered twice holds
 *   funds once.
 * - `journal_entry_id` — exactly one hold posting per reservation, so a
 *   reservation cannot be backed by two different balance movements.
 *
 * The partial `one live hold per intent` index is partial so that a
 * released, consumed, or expired hold stops blocking the next attempt the
 * moment it reaches a terminal state — which is what makes a genuine retry
 * possible once the release path exists.
 *
 * `intent_id` carries no foreign key into `approved_intents` yet. It should
 * — a hold on capital for an authorization nobody wrote down is exactly the
 * shape this family exists to refuse — but adding one changes the call
 * order of a merged, tested path (`reserveAvailable` would begin refusing
 * every caller that has not persisted its intent first), which is the
 * execution slice's contract to settle rather than this one's to assume.
 */

export const reservationStateEnum = pgEnum("reservation_state", [
  "active",
  "released",
  "consumed",
  "expired",
]);

export const reservations = pgTable(
  "reservations",
  {
    reservationId: text("reservation_id").primaryKey(),
    /** The approved economic intent this reservation serves. */
    intentId: text("intent_id").notNull(),
    /** Versioned attempt on that intent; starts at 1. */
    attempt: integer("attempt").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    assetId: text("asset_id").notNull(),
    assetScale: smallint("asset_scale").notNull(),
    amountBase: numeric("amount_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" }).notNull(),
    state: reservationStateEnum("state").notNull().default("active"),
    /** The `reservation-hold` entry that moved the funds. */
    journalEntryId: text("journal_entry_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** After this instant the hold authorizes nothing. */
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /**
     * What authorized and sized this hold. A reservation commits capital, so
     * it is an economic record in its own right and carries the same
     * provenance the posting it makes does (`AGENTS.md`, "Architecture and
     * implementation").
     */
    policyVersion: text("policy_version").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    /** Null when no LLM was involved. */
    modelVersion: text("model_version"),
    /** Null when no portfolio snapshot informed the hold. */
    portfolioSnapshotVersion: text("portfolio_snapshot_version"),
    /** Null when no market snapshot informed the hold. */
    marketSnapshotVersion: text("market_snapshot_version"),
  },
  (table) => [
    uniqueIndex("reservations_idempotency_key_key").on(table.idempotencyKey),
    uniqueIndex("reservations_intent_id_attempt_key").on(table.intentId, table.attempt),
    uniqueIndex("reservations_intent_id_active_key")
      .on(table.intentId)
      .where(sql`state = 'active'`),
    uniqueIndex("reservations_journal_entry_id_key").on(table.journalEntryId),
    index("reservations_correlation_id_idx").on(table.correlationId),
    index("reservations_state_expires_at_idx").on(table.state, table.expiresAt),
    foreignKey({
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.entryId],
      name: "reservations_journal_entry_id_fk",
    }),
    check("reservations_amount_positive", sql`amount_base > 0`),
    check("reservations_attempt_positive", sql`attempt >= 1`),
    check("reservations_scale_range", sql`asset_scale between 0 and 36`),
    check("reservations_window", sql`expires_at > occurred_at`),
    check(
      "reservations_provenance_present",
      sql`length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0`,
    ),
    foreignKey({
      columns: [table.assetId, table.assetScale],
      foreignColumns: [assetScales.assetId, assetScales.assetScale],
      name: "reservations_asset_scale_fk",
    }),
  ],
);

export type ReservationStateValue = (typeof reservationStateEnum.enumValues)[number];

/**
 * The durable `ApprovedEconomicIntent`: what policy authorized, frozen at
 * the moment it authorized it.
 *
 * Amounts are base units — `numeric(78, 0)` beside the scale of the asset
 * they count, with a composite foreign key into `asset_scales` so base
 * units at a scale the asset is not registered with have nowhere to point.
 * This is a money record rather than a decision record: the execution
 * runtime compares a fill against `max_spend_base` and the ledger posts in
 * base units, so storing decimal text here would put a parse and a scale
 * lookup between the authorization and every comparison made against it.
 * Two assets, so two scales: `input_*` is what is spent, `output_*` what is
 * acquired.
 *
 * `candidate_id` is nullable, and the foreign key is what makes it useful:
 * an intent that came from a recorded candidate must name one that exists,
 * so an authorization cannot claim a decision nobody journaled. It cannot
 * be `NOT NULL`, because a protective action has no candidate and
 * `docs/resilience.md` §2 forbids blocking one — a schema that demanded a
 * fabricated candidate row before an exit could be authorized would be a
 * schema that blocks protection.
 *
 * `operating_mode` records which mode authorized this, as text validated
 * against `@vigil/contracts`' `OPERATING_MODES` at the store boundary
 * rather than as a Postgres enum, for the reason `heartbeats` already
 * gives: that registry is owned by `packages/contracts`, and restating it
 * in SQL would give the application two vocabularies that drift apart
 * silently. Recording a mode grants no authority.
 */
export const approvedIntents = pgTable(
  "approved_intents",
  {
    intentId: text("intent_id").primaryKey(),
    /** The same approved proposal delivered twice authorizes one spend. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Ties this authorization to its candidate, holds, attempts, and postings. */
    correlationId: text("correlation_id").notNull(),
    /**
     * The economic action this intent is one authorization for. Unique
     * because `AGENTS.md` names it an idempotency key: two intents claiming
     * one economic action are two authorizations to do the same thing once.
     */
    economicActionId: text("economic_action_id").notNull(),
    /** The staged plan this intent executes a step of. */
    positionPlanId: text("position_plan_id").notNull(),
    /** The journaled decision this came from; null for a protective action. */
    candidateId: text("candidate_id"),
    /** `PAPER` today; an `OPERATING_MODES` member, checked at the boundary. */
    operatingMode: text("operating_mode").notNull(),
    /** Which account the spend comes out of. */
    fundingAccountId: text("funding_account_id").notNull(),
    venueId: text("venue_id").notNull(),
    /** Null for an exchange venue; a chain id for an on-chain route. */
    chainId: text("chain_id"),
    /** Null when the venue needs no route selection. */
    routeId: text("route_id"),
    inputAssetId: text("input_asset_id").notNull(),
    inputAssetScale: smallint("input_asset_scale").notNull(),
    outputAssetId: text("output_asset_id").notNull(),
    outputAssetScale: smallint("output_asset_scale").notNull(),
    /** How much of the output asset this authorizes acquiring. */
    quantityBase: numeric("quantity_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" }).notNull(),
    /** The hard ceiling on input-asset base units this may consume. */
    maxSpendBase: numeric("max_spend_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" }).notNull(),
    /** The floor on output-asset base units below which the trade is not worth doing. */
    minAcceptableReceiptBase: numeric("min_acceptable_receipt_base", {
      precision: BASE_UNIT_PRECISION,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    /** Input-asset base units that may be left unspent without treating the action as incomplete. */
    permittedResidualBase: numeric("permitted_residual_base", {
      precision: BASE_UNIT_PRECISION,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    /** After this instant the authorization is spent-or-void; it authorizes nothing. */
    validUntil: timestamp("valid_until", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** How old the market data behind an attempt may be at dispatch. */
    requiredFreshnessMs: integer("required_freshness_ms").notNull(),
    /**
     * The protection this position is meant to carry, as the plan reference
     * policy approved. Null when the action needs none. The structured
     * protective-order record belongs to the slice that places one.
     */
    protectionPlan: text("protection_plan"),
    /** What happens to inventory this action does not consume. */
    remainingInventoryTreatment: text("remaining_inventory_treatment").notNull(),
    /** What this action is measured against; null when nothing benchmarks it. */
    benchmarkId: text("benchmark_id"),
    /** Why policy approved, in its own words; null when it recorded none. */
    approvalReason: text("approval_reason"),
    /**
     * What the adapter claimed it could do when this was approved. Kept on
     * the authorization rather than read at dispatch: an adapter whose
     * capabilities changed between approval and submission is acting under
     * an authorization that assumed the old ones.
     */
    adapterCapabilityVersion: text("adapter_capability_version").notNull(),
    /** The simulation that cleared an on-chain route; null off-chain. */
    chainSimulationId: text("chain_simulation_id"),
    chainSimulationPassed: boolean("chain_simulation_passed"),
    /** When policy approved it. */
    approvedAt: timestamp("approved_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote it down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /**
     * The six version stamps. An authorization is the record a later
     * comparison attributes a spend to, so all but `model_version` are
     * `NOT NULL`: an intent that cannot say which market, portfolio, and fee
     * snapshots sized it is not point-in-time reproducible, and a null
     * there would mean nothing sized it at all.
     */
    policyVersion: text("policy_version").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    /** Null when no LLM was involved — every deterministic path today. */
    modelVersion: text("model_version"),
    portfolioSnapshotVersion: text("portfolio_snapshot_version").notNull(),
    marketSnapshotVersion: text("market_snapshot_version").notNull(),
    feeSnapshotVersion: text("fee_snapshot_version").notNull(),
  },
  (table) => [
    uniqueIndex("approved_intents_idempotency_key_key").on(table.idempotencyKey),
    uniqueIndex("approved_intents_economic_action_id_key").on(table.economicActionId),
    // Deliberately not unique: one correlation id ties an intent to its
    // candidate, holds, attempts, and postings (`docs/resilience.md` §10).
    index("approved_intents_correlation_id_idx").on(table.correlationId),
    foreignKey({
      columns: [table.candidateId],
      foreignColumns: [candidates.candidateId],
      name: "approved_intents_candidate_id_fk",
    }),
    foreignKey({
      columns: [table.inputAssetId, table.inputAssetScale],
      foreignColumns: [assetScales.assetId, assetScales.assetScale],
      name: "approved_intents_input_asset_scale_fk",
    }),
    foreignKey({
      columns: [table.outputAssetId, table.outputAssetScale],
      foreignColumns: [assetScales.assetId, assetScales.assetScale],
      name: "approved_intents_output_asset_scale_fk",
    }),
    check(
      "approved_intents_identity_present",
      sql`length(btrim(intent_id)) > 0 and length(btrim(idempotency_key)) > 0 and length(btrim(correlation_id)) > 0 and length(btrim(economic_action_id)) > 0`,
    ),
    check(
      "approved_intents_amounts_authorize_something",
      sql`quantity_base > 0 and max_spend_base > 0 and min_acceptable_receipt_base >= 0 and permitted_residual_base >= 0 and permitted_residual_base <= max_spend_base`,
    ),
    check("approved_intents_scale_range", sql.raw(`input_asset_scale between 0 and ${MAX_ASSET_SCALE} and output_asset_scale between 0 and ${MAX_ASSET_SCALE}`)),
    check("approved_intents_window", sql`valid_until > approved_at`),
    check("approved_intents_freshness_positive", sql`required_freshness_ms > 0`),
    // A simulation id without a verdict, or a verdict without the
    // simulation it came from, is evidence that cannot be checked.
    check("approved_intents_chain_validation_paired", sql`(chain_simulation_id is null) = (chain_simulation_passed is null)`),
    // `docs/architecture.md` "Execution lifecycles": an on-chain action
    // reaches POLICY_VALIDATED only after SIMULATED. An on-chain
    // authorization whose simulation did not pass is unrepresentable.
    check("approved_intents_chain_simulated", sql`chain_id is null or chain_simulation_passed is true`),
    check(
      "approved_intents_provenance_present",
      sql`length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0 and length(btrim(portfolio_snapshot_version)) > 0 and length(btrim(market_snapshot_version)) > 0 and length(btrim(fee_snapshot_version)) > 0`,
    ),
  ],
);

/**
 * The Exchange lifecycle from `docs/architecture.md` "Execution
 * lifecycles", as the states one attempt can be in. Spelled exactly as that
 * document spells them, so a reader can hold the two side by side.
 *
 * `UNKNOWN` is a state, not a failure (`docs/resilience.md` §3): a
 * submission or cancellation timeout lands here, and it is counted as live
 * by the one-live-attempt index below, so nothing may be resubmitted while
 * an attempt's fate is unknown. Leaving it requires reconciliation evidence
 * recorded in the same statement — see the `intent_lifecycle_guards`
 * migration.
 */
export const executionAttemptStateEnum = pgEnum("execution_attempt_state", [
  "SUBMITTING",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "UNKNOWN",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

/** The states in which an attempt's outcome is not yet settled. */
export const LIVE_EXECUTION_ATTEMPT_STATES = [
  "SUBMITTING",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "UNKNOWN",
] as const;

/** The states from which an attempt never moves again. */
export const TERMINAL_EXECUTION_ATTEMPT_STATES = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"] as const;

const LIVE_STATES_SQL = LIVE_EXECUTION_ATTEMPT_STATES.map((state) => `'${state}'`).join(", ");

/**
 * One versioned try at consuming an approved intent.
 *
 * It carries no asset ids and no provenance of its own: both are the
 * intent's, reached through a `NOT NULL` foreign key that cannot be absent,
 * and a second copy is a second answer that can disagree with the
 * authorization. It does carry the two scales, so `spent_base` and
 * `received_base` are interpretable from the row itself; the guard trigger
 * refuses an attempt whose scales are not the intent's, so the copy cannot
 * drift from what was authorized.
 *
 * `client_order_id` is what the venue sees. It is unique here so that a
 * resubmission of the same attempt collides in this table before it can
 * collide at the venue — and it is a column rather than a derivation
 * because which shape a venue accepts is the adapter's business.
 *
 * Money only ever moves forward on an attempt: the guard trigger refuses an
 * `UPDATE` that lowers `spent_base` or `received_base`. A fill that has been
 * confirmed cannot be un-confirmed by a later write, so a reconciliation
 * that disagrees with durable history is an incident to be recorded rather
 * than an edit that erases it.
 */
export const executionAttempts = pgTable(
  "execution_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    intentId: text("intent_id").notNull(),
    /** Versioned attempt on that intent; starts at 1. */
    attempt: integer("attempt").notNull(),
    /** The id the venue is given, so a resubmission is refused there too. */
    clientOrderId: text("client_order_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    state: executionAttemptStateEnum("state").notNull().default("SUBMITTING"),
    /** What the venue called this order; null until it acknowledges one. */
    venueOrderId: text("venue_order_id"),
    inputAssetScale: smallint("input_asset_scale").notNull(),
    outputAssetScale: smallint("output_asset_scale").notNull(),
    /** Input-asset base units this attempt has consumed, as confirmed by the venue. */
    spentBase: numeric("spent_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Output-asset base units this attempt has acquired, as confirmed by the venue. */
    receivedBase: numeric("received_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** When the attempt was opened — written before anything is submitted. */
    submittedAt: timestamp("submitted_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When the current state was observed at the venue. */
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote the current state down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /**
     * The reconciliation that last resolved this attempt against the
     * venue's own confirmed state, and when. Null until one has. Leaving
     * `UNKNOWN` requires a *new* instant here, which is what makes
     * "reconciliation precedes resubmission" unskippable rather than
     * documented.
     */
    reconciledAt: timestamp("reconciled_at", { withTimezone: true, precision: 3, mode: "date" }),
    reconciliationId: text("reconciliation_id"),
  },
  (table) => [
    // A table constraint rather than a bare unique index, because the
    // outbox's composite foreign key points at these two columns: a
    // constraint is created with the table, before the migration's foreign
    // keys are added, while a unique index is created after them and would
    // leave the reference with nothing to match.
    unique("execution_attempts_intent_id_attempt_key").on(table.intentId, table.attempt),
    uniqueIndex("execution_attempts_client_order_id_key").on(table.clientOrderId),
    // One live attempt per intent. UNKNOWN counts as live, so an attempt
    // whose fate nobody has reconciled blocks the next one.
    uniqueIndex("execution_attempts_intent_id_live_key")
      .on(table.intentId)
      .where(sql.raw(`state in (${LIVE_STATES_SQL})`)),
    // Consumable exactly once: at most one attempt per intent may ever
    // record a spend.
    uniqueIndex("execution_attempts_intent_id_consumed_key")
      .on(table.intentId)
      .where(sql`spent_base > 0`),
    index("execution_attempts_correlation_id_idx").on(table.correlationId),
    foreignKey({
      columns: [table.intentId],
      foreignColumns: [approvedIntents.intentId],
      name: "execution_attempts_intent_id_fk",
    }),
    check("execution_attempts_attempt_positive", sql`attempt >= 1`),
    check("execution_attempts_amounts_non_negative", sql`spent_base >= 0 and received_base >= 0`),
    // Receiving without spending is not a fill; it is a row that says this
    // application got something for nothing.
    check("execution_attempts_received_implies_spent", sql`received_base = 0 or spent_base > 0`),
    check(
      "execution_attempts_scale_range",
      sql.raw(`input_asset_scale between 0 and ${MAX_ASSET_SCALE} and output_asset_scale between 0 and ${MAX_ASSET_SCALE}`),
    ),
    check("execution_attempts_reconciliation_paired", sql`(reconciled_at is null) = (reconciliation_id is null)`),
    check(
      "execution_attempts_instants_ordered",
      sql`state_changed_at >= submitted_at and (reconciled_at is null or reconciled_at >= submitted_at)`,
    ),
    check("execution_attempts_identity_present", sql`length(btrim(client_order_id)) > 0 and length(btrim(correlation_id)) > 0`),
  ],
);

/**
 * How far a dispatch got. Lower case, like `reservation_state`: these are
 * this application's own handoff states rather than the venue's, and the
 * upper-case vocabulary belongs to the lifecycle `docs/architecture.md`
 * defines.
 *
 * `dispatched` means the payload left this application, not that the venue
 * accepted it — what the venue did is the attempt's state, and the gap
 * between the two is exactly where `UNKNOWN` lives.
 */
export const dispatchStateEnum = pgEnum("dispatch_state", ["pending", "dispatched", "abandoned"]);

/**
 * The durable outbox (`docs/resilience.md` §9). A row is written, and
 * committed, before anything is handed to an adapter; the guard trigger
 * refuses an insert in any state but `pending`, so a dispatch that was
 * never durable beforehand cannot be recorded after the fact.
 *
 * A crashed dispatcher therefore leaves a `pending` row behind rather than
 * nothing, which is the whole point: on restart the application knows a
 * dispatch may have gone out and must reconcile before doing anything else
 * with that attempt.
 *
 * `fencing_token` is what `docs/resilience.md` §7 needs the schema to
 * carry: a monotonic token whose holder is the one effective writer. The
 * guard trigger refuses any update carrying a token lower than the row's,
 * so a stale writer cannot mark a dispatch it no longer owns. That is
 * necessary and not sufficient, and the document says so — fencing must
 * remove the outgoing writer's real capability at the venue, which no
 * column here can do.
 */
export const intentDispatchOutbox = pgTable(
  "intent_dispatch_outbox",
  {
    dispatchId: text("dispatch_id").primaryKey(),
    intentId: text("intent_id").notNull(),
    attempt: integer("attempt").notNull(),
    correlationId: text("correlation_id").notNull(),
    state: dispatchStateEnum("state").notNull().default("pending"),
    /**
     * SHA-256 hex of the payload this dispatch will send, so a resumed
     * dispatcher can prove the payload it is about to send is the one that
     * was authorized. A digest rather than the payload: nothing in this
     * family ever holds a credential, a key, or signing material.
     */
    payloadDigest: text("payload_digest").notNull(),
    /** Which writer claimed this row. */
    dispatcherInstanceId: text("dispatcher_instance_id").notNull(),
    /** Monotonic; a lower token is a fenced writer and is refused. */
    fencingToken: bigint("fencing_token", { mode: "bigint" }).notNull(),
    /** When the row was enqueued — before any dispatch. */
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote it down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When the payload actually left; null until it has. */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, precision: 3, mode: "date" }),
    /** A `REASON_CODES` member, checked at the store boundary; null unless abandoned. */
    abandonmentReasonCode: text("abandonment_reason_code"),
  },
  (table) => [
    // One dispatch per attempt. A second dispatch record for the same
    // attempt is a second submission of one authorization.
    uniqueIndex("intent_dispatch_outbox_intent_id_attempt_key").on(table.intentId, table.attempt),
    index("intent_dispatch_outbox_correlation_id_idx").on(table.correlationId),
    // The read a dispatcher and a restart recovery both walk.
    index("intent_dispatch_outbox_state_enqueued_at_idx").on(table.state, table.enqueuedAt),
    foreignKey({
      columns: [table.intentId, table.attempt],
      foreignColumns: [executionAttempts.intentId, executionAttempts.attempt],
      name: "intent_dispatch_outbox_attempt_fk",
    }),
    check("intent_dispatch_outbox_attempt_positive", sql`attempt >= 1`),
    check("intent_dispatch_outbox_fencing_token_positive", sql`fencing_token > 0`),
    // A SHA-256 digest and nothing else can live in this column.
    check("intent_dispatch_outbox_payload_digest_shape", sql.raw(`payload_digest ~ '^[0-9a-f]{64}$'`)),
    // A dispatched row must say when; a pending or abandoned one must not
    // claim a dispatch instant it never had.
    check("intent_dispatch_outbox_dispatched_at_paired", sql`(state = 'dispatched') = (dispatched_at is not null)`),
    // Giving up on a dispatch is a decision, and a decision carries a
    // reason code (`docs/resilience.md` §4).
    check(
      "intent_dispatch_outbox_abandonment_reasoned",
      sql`(state = 'abandoned') = (abandonment_reason_code is not null)`,
    ),
    check(
      "intent_dispatch_outbox_instants_ordered",
      sql`dispatched_at is null or dispatched_at >= enqueued_at`,
    ),
    check(
      "intent_dispatch_outbox_identity_present",
      sql`length(btrim(dispatch_id)) > 0 and length(btrim(correlation_id)) > 0 and length(btrim(dispatcher_instance_id)) > 0`,
    ),
  ],
);

export type ApprovedIntentRow = typeof approvedIntents.$inferSelect;
export type ExecutionAttemptStateValue = (typeof executionAttemptStateEnum.enumValues)[number];
export type DispatchStateValue = (typeof dispatchStateEnum.enumValues)[number];
