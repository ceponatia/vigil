-- Lifecycle guards for the intents record family.
--
-- Four rules this schema exists to hold cannot be written as a column
-- constraint, because each of them compares a row to its own past, to the
-- authorization it belongs to, or to a set of sibling rows:
--
--   1. an approved intent, and the cost evidence that justified it, are
--      immutable;
--   2. the persisted cost components sum to the total the intent claims;
--   3. an attempt is opened before it acts, is versioned rather than
--      re-authorized, and leaves UNKNOWN only through reconciliation;
--   4. a dispatch record exists, pending, before anything is dispatched,
--      and a fenced writer cannot mark one.
--
-- Row-level triggers do not fire for TRUNCATE, so an integration suite can
-- still reset its own tables between cases. Nothing in the application ever
-- truncates them.
--
-- Refusals that are really constraint violations are raised with SQLSTATE
-- 23514 and an explicit CONSTRAINT name, so `postgresConstraintName()` in
-- packages/db/src/store/pg-errors.ts reads back the exact rule that fired
-- and the store returns a reason code rather than a stack trace
-- (docs/resilience.md §4). The flat append-only refusals keep P0001, as
-- the journal and candidate guards already do.

-- 1. An approved intent, and its cost evidence, are immutable once approved.
--
-- `ApprovedEconomicIntent` is "immutable once approved, consumable exactly
-- once economically" (docs/architecture.md "Contracts"). This is the
-- immutable half, and it is deliberately total: every UPDATE and every
-- DELETE, not a guard over a list of authorizing columns. A column list has
-- to be maintained, and the column a later slice forgets to add to it is
-- exactly the one that becomes quietly mutable — while a total guard costs
-- nothing, because an intent carries no lifecycle of its own. Its
-- consumption lives on `execution_attempts`, whose whole purpose is to
-- change state.
--
-- `intent_cost_components` is guarded with its parent, for the reason
-- `candidate_tranches` is guarded with `candidates`: evidence whose line
-- items can be rewritten after the fact is not evidence. Editing a cost
-- component after approval would make an intent that missed its hurdle look
-- as though it cleared one.
--
-- Note the asymmetry with consume-once, which survives its trigger being
-- dropped because the partial unique index holds on its own. Immutability
-- has no such backstop — "this row may not change" is not a uniqueness
-- claim — so the role that runs migrations and the role that runs the
-- application should differ before anything real runs.
CREATE FUNCTION vigil_approved_intent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'an approved economic intent and its cost evidence are immutable: a changed authorization is a new intent, and a retry is a versioned execution attempt (attempted % on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approved_intents_append_only
  BEFORE UPDATE OR DELETE ON "approved_intents"
  FOR EACH ROW EXECUTE FUNCTION vigil_approved_intent_append_only();
--> statement-breakpoint
CREATE TRIGGER intent_cost_components_append_only
  BEFORE UPDATE OR DELETE ON "intent_cost_components"
  FOR EACH ROW EXECUTE FUNCTION vigil_approved_intent_append_only();
--> statement-breakpoint

-- 2. The cost components sum to the total the intent claims.
--
-- `expected_total_cost_base` is the figure `expected_net_edge_base` is
-- derived from, and therefore the figure the hurdle was judged against. If
-- the named components do not add up to it, the breakdown is decoration:
-- a later evaluation comparing expected against realized cost would be
-- comparing against a number no component supports.
--
-- Only the numeraire amounts are summed, and the check constraint on
-- `intent_cost_components` has already refused any row whose native asset
-- differs from the numeraire without naming a conversion source — so this
-- sum is never an addition of amounts in different assets.
--
-- Deferred to commit, and attached to both tables, for the reason
-- `journal_entries_balanced` is: the components of one intent arrive as
-- separate rows after the parent, so an immediate check would fire on the
-- intent insert and reject every intent that has any costs at all. An
-- intent with no components is legal and must have a zero total, which
-- `coalesce` gives it.
CREATE FUNCTION vigil_intent_cost_components_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_intent text;
  claimed numeric;
  itemised numeric;
BEGIN
  target_intent := NEW.intent_id;

  SELECT intent.expected_total_cost_base INTO claimed
    FROM approved_intents intent
   WHERE intent.intent_id = target_intent;

  -- Gone, or never there: the foreign key has its own, better complaint.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(component.numeraire_amount_base), 0) INTO itemised
    FROM intent_cost_components component
   WHERE component.intent_id = target_intent;

  IF itemised <> claimed THEN
    RAISE EXCEPTION
      'intent % claims a total incremental cost of % but its components sum to %; the breakdown must account for the figure net edge was derived from',
      target_intent, claimed, itemised
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER approved_intents_costs_itemised
  AFTER INSERT ON "approved_intents"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vigil_intent_cost_components_total();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER intent_cost_components_itemised
  AFTER INSERT ON "intent_cost_components"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vigil_intent_cost_components_total();
--> statement-breakpoint

-- 3a. An attempt is opened before it acts, on an authorization that is
--     still valid and not already consumed.
--
-- Persistence before action (docs/resilience.md §9) is only half enforced
-- by the foreign key: the key proves an attempt names an authorization that
-- exists, but not that the row was written *before* anything happened. A
-- row inserted already ACKNOWLEDGED, or already carrying a fill, is the
-- record of an action that was never durable beforehand — so a new attempt
-- must be born in SUBMITTING with nothing spent and nothing received.
--
-- The consumed-intent check is what stops the second dispatch rather than
-- merely making it unrecordable afterwards. Without it, an intent whose
-- first attempt filled and went terminal would leave the one-live-attempt
-- index free, a second attempt could be opened and dispatched, and the
-- database would only refuse the row that records the spend — after the
-- money had already moved.
--
-- The row lock below is not decoration, and the case it closes was
-- reproduced against Postgres 18 before it was written. Under READ
-- COMMITTED, a transaction that has recorded a fill but not committed is
-- invisible to this trigger's snapshot: the check saw `spent_base = 0`,
-- passed, and the insert then waited on `execution_attempts_intent_id_live_key`
-- because attempt 1 was still live. When the filling transaction committed,
-- attempt 1 left that partial index, the wait resolved, and the insert
-- succeeded — leaving attempt 2 open and dispatchable on an intent that had
-- just been economically consumed. The trigger does not run again at that
-- point, so nothing re-checked it. Taking the lock first makes the two
-- orders mutually exclusive: a filling transaction already holds the row
-- lock on the attempt it updates, so this statement waits for it, and the
-- consumed check that follows runs on a fresh snapshot that sees the
-- committed spend. `ORDER BY attempt` keeps the lock order deterministic,
-- so two openers cannot deadlock against each other.
--
-- Locking the attempts rather than the parent intent is deliberate: any
-- writer that records a fill takes those row locks automatically, whether
-- or not it went through this package, while a lock on `approved_intents`
-- would only work for writers that remembered to take it.
CREATE FUNCTION vigil_execution_attempt_opened() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent approved_intents%ROWTYPE;
  consumed boolean;
BEGIN
  SELECT * INTO intent FROM approved_intents WHERE intent_id = NEW.intent_id;

  -- Not found: the foreign key rejects this row on its own, with a better
  -- message than anything this trigger could raise.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.state <> 'SUBMITTING' THEN
    RAISE EXCEPTION
      'execution attempt % is opened in state %; an attempt is persisted as SUBMITTING before anything is submitted',
      NEW.attempt_id, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_opened_submitting';
  END IF;

  IF NEW.spent_base <> 0 OR NEW.received_base <> 0 OR NEW.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION
      'execution attempt % is opened already carrying an outcome; the durable record precedes the action it records',
      NEW.attempt_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_opened_empty';
  END IF;

  IF NEW.input_asset_scale <> intent.input_asset_scale OR NEW.output_asset_scale <> intent.output_asset_scale THEN
    RAISE EXCEPTION
      'execution attempt % denominates its amounts at scales (%, %) but intent % authorized (%, %)',
      NEW.attempt_id, NEW.input_asset_scale, NEW.output_asset_scale,
      intent.intent_id, intent.input_asset_scale, intent.output_asset_scale
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_scales_match_intent';
  END IF;

  IF NEW.submitted_at > intent.valid_until THEN
    RAISE EXCEPTION
      'intent % authorized nothing after %; execution attempt % was opened at %',
      intent.intent_id, intent.valid_until, NEW.attempt_id, NEW.submitted_at
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_within_intent_window';
  END IF;

  -- Wait for any in-flight write to this intent's attempts, then look.
  PERFORM 1 FROM execution_attempts prior
    WHERE prior.intent_id = NEW.intent_id
    ORDER BY prior.attempt
    FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM execution_attempts prior
     WHERE prior.intent_id = NEW.intent_id AND prior.spent_base > 0
  ) INTO consumed;

  IF consumed THEN
    RAISE EXCEPTION
      'intent % has already been economically consumed; a remainder is a new authorization, not a further attempt on this one',
      intent.intent_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_intent_not_consumed';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_opened
  BEFORE INSERT ON "execution_attempts"
  FOR EACH ROW EXECUTE FUNCTION vigil_execution_attempt_opened();
--> statement-breakpoint

-- 3b. An attempt moves forward only, and leaves UNKNOWN only through
--     reconciliation.
--
-- UNKNOWN is a state, not a failure (docs/resilience.md §3): it resolves
-- "only through reconciliation against the venue's or chain's own confirmed
-- state". A plain `update … set state = 'FILLED'` against an UNKNOWN
-- attempt is precisely the assumption that rule forbids, so leaving UNKNOWN
-- requires a reconciliation recorded in the same statement — and a
-- *different* one from whatever already settled this attempt.
--
-- The rule keys on `reconciliation_id`, not on `reconciled_at`, because the
-- identity of a reconciliation is its id. Keying on the instant fails in
-- both directions: `reconciled_at` is timestamp(3), so a genuinely new
-- reconciliation landing in the same millisecond would be refused and the
-- attempt stranded in UNKNOWN; and re-sending the same reconciliation with
-- a bumped clock reading would be accepted, which is the assumption the
-- rule exists to prevent wearing a fresh timestamp.
--
-- A terminal attempt is history and takes no further writes. The
-- consequence is deliberate: a reconciliation that disagrees with a settled
-- attempt is an incident to record, never an edit that erases what this
-- application already believed.
--
-- Deliberately NOT enforced here: that `state_changed_at` moves forward.
-- The obvious version of that rule compares the venue's clock with this
-- application's and refuses a fill stamped fractionally early — the attempt
-- would sit at SUBMITTING while the venue had the money. The subtler
-- version, comparing each `state_changed_at` with the previous one, has the
-- same defect in two places: an attempt is opened with `state_changed_at`
-- seeded from `submitted_at`, which is OUR clock, so the first venue-observed
-- transition is a cross-clock comparison however the rule is phrased; and a
-- locally-decided EXPIRED following a venue ACKNOWLEDGED crosses back the
-- other way. This column holds whichever clock observed the state, so no
-- comparison between two of its values is safe.
--
-- What is left is a guard that cannot refuse a real event, because it reads
-- no clock at all: `outcome_monotonic` below. Money already recorded cannot
-- be un-recorded, whatever any timestamp says — and that, not the ordering
-- of observations, is the invariant that protects capital. An out-of-order
-- poll can still rewrite state; a reader takes the newest record, and the
-- terminal and UNKNOWN rules bound what it can rewrite state to.
--
-- Deliberately NOT enforced here: a cap of `spent_base` at the intent's
-- `max_spend_base`. A fill that exceeds the authorization has already
-- happened at the venue by the time it is recorded, and refusing to persist
-- it would leave the application blind to money that actually moved. The
-- cap belongs to policy and to the order this application places, ahead of
-- the spend; this table's job is to record what the venue confirmed,
-- including the figure that should never have occurred.
CREATE FUNCTION vigil_execution_attempt_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'execution attempts are append-only history: attempt % on intent % may not be deleted',
      OLD.attempt_id, OLD.intent_id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.client_order_id IS DISTINCT FROM OLD.client_order_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.input_asset_scale IS DISTINCT FROM OLD.input_asset_scale
     OR NEW.output_asset_scale IS DISTINCT FROM OLD.output_asset_scale
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION
      'execution attempt % may change only its outcome; what it is an attempt at is fixed when it is opened',
      OLD.attempt_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_identity_immutable';
  END IF;

  IF OLD.state IN ('FILLED', 'CANCELED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION
      'execution attempt % is settled as %; a settled attempt takes no further writes',
      OLD.attempt_id, OLD.state
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_terminal_is_final';
  END IF;

  IF OLD.state = 'UNKNOWN' AND NEW.state <> 'UNKNOWN'
     AND (NEW.reconciliation_id IS NULL
          OR NEW.reconciled_at IS NULL
          OR NEW.reconciliation_id IS NOT DISTINCT FROM OLD.reconciliation_id) THEN
    RAISE EXCEPTION
      'execution attempt % is UNKNOWN and resolves only through a reconciliation against the venue''s confirmed state, named in the same write and not the one that settled it before',
      OLD.attempt_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_unknown_needs_reconciliation';
  END IF;

  IF NEW.spent_base < OLD.spent_base OR NEW.received_base < OLD.received_base THEN
    RAISE EXCEPTION
      'execution attempt % cannot un-confirm money it already recorded (spent % -> %, received % -> %)',
      OLD.attempt_id, OLD.spent_base, NEW.spent_base, OLD.received_base, NEW.received_base
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_outcome_monotonic';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_transition
  BEFORE UPDATE OR DELETE ON "execution_attempts"
  FOR EACH ROW EXECUTE FUNCTION vigil_execution_attempt_transition();
--> statement-breakpoint

-- 4a. A dispatch record is written, pending, before anything is dispatched.
--
-- "Dispatch goes through a durable outbox. If a durable record cannot be
-- written, no new economic action proceeds" (docs/resilience.md §9). A row
-- inserted already `dispatched` is the record of a dispatch that was never
-- durable beforehand — which is exactly the failure the outbox exists to
-- prevent, written down as if it had been prevented. A crashed dispatcher
-- must leave a `pending` row behind rather than nothing, so that a restart
-- knows a dispatch may have gone out and reconciles before acting.
CREATE FUNCTION vigil_intent_dispatch_enqueued() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'pending' THEN
    RAISE EXCEPTION
      'dispatch % is enqueued as %; the durable record is written pending, and committed, before anything is dispatched',
      NEW.dispatch_id, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'intent_dispatch_outbox_enqueued_pending';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intent_dispatch_outbox_enqueued
  BEFORE INSERT ON "intent_dispatch_outbox"
  FOR EACH ROW EXECUTE FUNCTION vigil_intent_dispatch_enqueued();
--> statement-breakpoint

-- 4b. One effective writer, fenced; and what was dispatched is what was
--     authorized.
--
-- docs/resilience.md §7 requires exactly one process to hold dispatch
-- authority per authority domain, and a failover to fence the outgoing
-- writer before the incoming one acts. `fencing_token` is the schema's part
-- of that: a writer carrying a token lower than the row's is a writer that
-- has been fenced, and its write is refused here rather than by whichever
-- process happens to notice.
--
-- Two things this cannot do, both named so nobody mistakes the token for
-- more than it is. It cannot remove the outgoing writer's real capability
-- at the venue, which is what §7 actually demands — this stops a stale
-- process from rewriting the record of a dispatch, not from holding an open
-- socket. And it cannot fence a writer carrying a token *equal* to the
-- row's, which today includes the writer that enqueued the row: no exported
-- path raises the token on a pending row, so a claim step that does is owed
-- by the slice that runs dispatchers.
--
-- `payload_digest` is immutable for the same reason the intent is: a digest
-- that can be rewritten after the row is committed proves nothing about
-- what was sent.
CREATE FUNCTION vigil_intent_dispatch_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'the dispatch outbox is durable history: dispatch % may not be deleted',
      OLD.dispatch_id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at THEN
    RAISE EXCEPTION
      'dispatch % may change only how far it got; what it dispatches is fixed when it is enqueued',
      OLD.dispatch_id
      USING ERRCODE = '23514', CONSTRAINT = 'intent_dispatch_outbox_payload_immutable';
  END IF;

  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION
      'dispatch % is held at fencing token %; a writer carrying % has been fenced',
      OLD.dispatch_id, OLD.fencing_token, NEW.fencing_token
      USING ERRCODE = '23514', CONSTRAINT = 'intent_dispatch_outbox_fencing_monotonic';
  END IF;

  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION
      'dispatch % is settled as %; a dispatched or abandoned row takes no further writes',
      OLD.dispatch_id, OLD.state
      USING ERRCODE = '23514', CONSTRAINT = 'intent_dispatch_outbox_terminal_is_final';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intent_dispatch_outbox_transition
  BEFORE UPDATE OR DELETE ON "intent_dispatch_outbox"
  FOR EACH ROW EXECUTE FUNCTION vigil_intent_dispatch_transition();
