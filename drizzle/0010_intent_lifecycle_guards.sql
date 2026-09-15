-- Lifecycle guards for the intents record family.
--
-- Three rules this schema exists to hold cannot be written as a column
-- constraint, because each of them compares a row to its own past, or to
-- the authorization it belongs to:
--
--   1. an approved intent is immutable;
--   2. an attempt is opened before it acts, is versioned rather than
--      re-authorized, and leaves UNKNOWN only through reconciliation;
--   3. a dispatch record exists, pending, before anything is dispatched,
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

-- 1. An approved intent is immutable once approved.
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
-- The consumable-once half is the partial unique index
-- `execution_attempts_intent_id_consumed_key` plus rule 2's refusal to open
-- a new attempt on an intent some earlier attempt already consumed.
CREATE FUNCTION vigil_approved_intent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'an approved economic intent is immutable: a changed authorization is a new intent, and a retry is a versioned execution attempt (attempted % on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approved_intents_append_only
  BEFORE UPDATE OR DELETE ON "approved_intents"
  FOR EACH ROW EXECUTE FUNCTION vigil_approved_intent_append_only();
--> statement-breakpoint

-- 2a. An attempt is opened before it acts, on an authorization that is
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
-- money had already moved. Two concurrent inserts are serialised by that
-- same index, since both are born SUBMITTING and only one may be live.
CREATE FUNCTION vigil_execution_attempt_opened() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent approved_intents%ROWTYPE;
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

  IF EXISTS (SELECT 1 FROM execution_attempts prior WHERE prior.intent_id = NEW.intent_id AND prior.spent_base > 0) THEN
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

-- 2b. An attempt moves forward only, and leaves UNKNOWN only through
--     reconciliation.
--
-- UNKNOWN is a state, not a failure (docs/resilience.md §3): it resolves
-- "only through reconciliation against the venue's or chain's own confirmed
-- state". A plain `update … set state = 'FILLED'` against an UNKNOWN
-- attempt is precisely the assumption that rule forbids, so leaving UNKNOWN
-- requires a reconciliation recorded in the same statement — and a *new*
-- one: `reconciled_at` must differ from the value already on the row, so an
-- attempt that went UNKNOWN a second time cannot be resolved by the
-- reconciliation that settled it the first time.
--
-- A terminal attempt is history and takes no further writes. The
-- consequence is deliberate: a reconciliation that disagrees with a settled
-- attempt is an incident to record, never an edit that erases what this
-- application already believed.
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
     AND (NEW.reconciled_at IS NULL
          OR NEW.reconciliation_id IS NULL
          OR NEW.reconciled_at IS NOT DISTINCT FROM OLD.reconciled_at) THEN
    RAISE EXCEPTION
      'execution attempt % is UNKNOWN and resolves only through reconciliation against the venue''s confirmed state, recorded in the same write',
      OLD.attempt_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_unknown_needs_reconciliation';
  END IF;

  IF NEW.spent_base < OLD.spent_base OR NEW.received_base < OLD.received_base THEN
    RAISE EXCEPTION
      'execution attempt % cannot un-confirm money it already recorded (spent % -> %, received % -> %)',
      OLD.attempt_id, OLD.spent_base, NEW.spent_base, OLD.received_base, NEW.received_base
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_outcome_monotonic';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state_changed_at < OLD.state_changed_at THEN
    RAISE EXCEPTION
      'execution attempt % changed state at %, before the state it is leaving was observed at %',
      OLD.attempt_id, NEW.state_changed_at, OLD.state_changed_at
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_states_ordered';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_transition
  BEFORE UPDATE OR DELETE ON "execution_attempts"
  FOR EACH ROW EXECUTE FUNCTION vigil_execution_attempt_transition();
--> statement-breakpoint

-- 3a. A dispatch record is written, pending, before anything is dispatched.
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

-- 3b. One effective writer, fenced; and what was dispatched is what was
--     authorized.
--
-- docs/resilience.md §7 requires exactly one process to hold dispatch
-- authority per authority domain, and a failover to fence the outgoing
-- writer before the incoming one acts. `fencing_token` is the schema's part
-- of that: a writer carrying a token lower than the row's is a writer that
-- has been fenced, and its write is refused here rather than by whichever
-- process happens to notice. That is necessary and not sufficient, and §7
-- says so — fencing must remove the outgoing writer's real capability at
-- the venue, which no column can do. This trigger stops a stale process
-- from rewriting the record of a dispatch; it cannot stop it from holding
-- an open socket.
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
