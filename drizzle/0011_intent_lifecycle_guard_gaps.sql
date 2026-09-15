-- Four gaps in the intents lifecycle guards, found in review of #43.
--
-- Each is a case the guards in 0010 were written to cover and do not, and
-- each is fixed here rather than by editing 0010, which is published on an
-- open pull request that CI has already run against. The two trigger
-- functions are replaced whole with CREATE OR REPLACE, so the triggers that
-- already point at them pick up the new bodies without being re-created.

-- 1. An exchange attempt is not a chain transaction.
--
-- `approved_intents` accepts a `chain_id`, and `execution_attempt_state` is
-- the Exchange lifecycle and only that one — SIGNING, BROADCAST, PENDING,
-- INCLUDED and FINALIZED live in the `transactions` record family, which is
-- not built. Until it is, an on-chain authorization has no lifecycle to be
-- attempted in, and opening an exchange attempt for one would record a
-- broadcast as ACKNOWLEDGED and a chain reorganization as a cancellation:
-- the collapse into one abstraction `docs/architecture.md` explicitly
-- rejects. The schema module said so in a comment; this is the enforcement.
--
-- 2. `attempt_id` is part of what an attempt is, not part of its outcome.
--
-- The identity guard compared every other fixed column and omitted the
-- primary key itself, so a direct writer could rename an attempt. Nothing
-- references `attempt_id` — the outbox points at `(intent_id, attempt)` —
-- so the rename would have been silent.
--
-- 3. The venue's order identifier is assigned once.
--
-- `coalesce(new, old)` in the store keeps the stored id only when the
-- incoming one is null, so an out-of-order or misassociated event naming a
-- different order overwrote it and pointed every later reconciliation at the
-- wrong order. Null to a value is an assignment; a value to a different
-- value is a misassociation.
--
-- 4. A state that asserts a fill must carry one.
--
-- This is the serious one. FILLED with both confirmed amounts zero passed
-- every guard: FILLED is terminal, so the attempt left
-- `execution_attempts_intent_id_live_key`; `spent_base` was zero, so it
-- never entered `execution_attempts_intent_id_consumed_key`; and the
-- consumed check in the opening trigger reads that same column. The
-- authorization fell through the gap between the two indexes and a second
-- attempt could be opened and dispatched against it. An adapter reporting a
-- fill it cannot quantify is refused instead, which leaves the attempt in
-- whatever live state it already held — still blocking a retry, still
-- resolvable by reconciliation. Refusing fails closed; accepting the row
-- would have failed open.
--
-- PARTIALLY_FILLED is held to the same rule even though it stays live and so
-- opens no gap, because a partial fill of nothing is not a partial fill.
-- CANCELED, REJECTED and EXPIRED are deliberately NOT held to it: those
-- states legitimately carry zero amounts, and an intent nothing was spent
-- against genuinely is available for another attempt.
CREATE OR REPLACE FUNCTION vigil_execution_attempt_opened() RETURNS trigger
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

  IF intent.chain_id IS NOT NULL THEN
    RAISE EXCEPTION
      'intent % routes over chain %, and the exchange attempt lifecycle cannot describe a broadcast; an on-chain action waits for the transactions record family',
      intent.intent_id, intent.chain_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_exchange_intents_only';
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

  IF NEW.correlation_id <> intent.correlation_id THEN
    RAISE EXCEPTION
      'execution attempt % carries correlation %, but intent % is threaded under %; one economic action has one correlation id',
      NEW.attempt_id, NEW.correlation_id, intent.intent_id, intent.correlation_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_correlation_matches_intent';
  END IF;

  IF NEW.submitted_at > intent.valid_until THEN
    RAISE EXCEPTION
      'intent % authorized nothing after %; execution attempt % was opened at %',
      intent.intent_id, intent.valid_until, NEW.attempt_id, NEW.submitted_at
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_within_intent_window';
  END IF;

  -- Wait for any in-flight write to this intent's attempts, then look. The
  -- lock is what closes the READ COMMITTED window reproduced in
  -- tests/fault-injection/concurrent-intent-consumption.int.test.ts.
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
CREATE OR REPLACE FUNCTION vigil_execution_attempt_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'execution attempts are append-only history: attempt % on intent % may not be deleted',
      OLD.attempt_id, OLD.intent_id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
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

  IF OLD.venue_order_id IS NOT NULL AND NEW.venue_order_id IS DISTINCT FROM OLD.venue_order_id THEN
    RAISE EXCEPTION
      'execution attempt % is already associated with venue order %; an event naming % is about a different order',
      OLD.attempt_id, OLD.venue_order_id, NEW.venue_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_venue_order_assigned_once';
  END IF;

  IF OLD.state IN ('FILLED', 'CANCELED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION
      'execution attempt % is settled as %; a settled attempt takes no further writes',
      OLD.attempt_id, OLD.state
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_terminal_is_final';
  END IF;

  IF NEW.state IN ('FILLED', 'PARTIALLY_FILLED') AND (NEW.spent_base <= 0 OR NEW.received_base <= 0) THEN
    RAISE EXCEPTION
      'execution attempt % reports % having spent % and received %; a fill this application cannot quantify would settle the attempt without consuming the intent, leaving the authorization open to a second attempt',
      OLD.attempt_id, NEW.state, NEW.spent_base, NEW.received_base
      USING ERRCODE = '23514', CONSTRAINT = 'execution_attempts_fill_confirms_amounts';
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

-- 5. The cost evidence is sealed when the intent is written.
--
-- The append-only guard blocks UPDATE and DELETE, which left INSERT open:
-- a later writer could add a component the approval never had. The deferred
-- total does not catch it, and the case that proves it does not is a
-- component whose numeraire amount is zero — the sum still balances, the
-- constraint stays silent, and a cost in another asset appears in evidence
-- that was supposed to be frozen at approval.
--
-- The test is whether the intent row was written by the transaction now
-- adding the component. `xmin` is the transaction that inserted the intent;
-- comparing it to `pg_current_xact_id()` answers "did we write this intent
-- ourselves, moments ago?" — the only case in which a component may still be
-- added. `approved_intents` is append-only, so that `xmin` never changes and
-- is a fixed reference point for the life of the row.
--
-- This is the mechanism `drizzle/0005_journal_entry_sealed_guard.sql`
-- already uses to seal a posted journal entry against later postings,
-- including its known limitation: a row inserted inside a SAVEPOINT carries
-- the subtransaction's id, which does not equal the top-level
-- `pg_current_xact_id()`. No store path uses savepoints; one that did would
-- have to seal intents with an explicit marker instead.
CREATE FUNCTION vigil_intent_cost_components_sealed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent_writer xid;
BEGIN
  SELECT intent.xmin INTO intent_writer
    FROM approved_intents intent
   WHERE intent.intent_id = NEW.intent_id;

  -- Not found: the foreign key rejects this row on its own.
  IF FOUND AND intent_writer <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION
      'intent % was approved by an earlier transaction; its cost evidence is sealed, and a cost discovered later is a new intent rather than an addition to this one',
      NEW.intent_id
      USING ERRCODE = '23514', CONSTRAINT = 'intent_cost_components_sealed';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intent_cost_components_sealed
  BEFORE INSERT ON "intent_cost_components"
  FOR EACH ROW EXECUTE FUNCTION vigil_intent_cost_components_sealed();
