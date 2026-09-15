-- Append-only guard for a staged plan's terms.
--
-- `position_plans` holds the two figures the pre-dispatch economic gate
-- measures against: the band an entry may be taken in, and the price the
-- thesis is aiming at. An approved intent is granted against those terms,
-- and `approved_intents` is already append-only for the reason this table
-- now is — an authorization that can be edited after the fact is not an
-- authorization. Leaving the terms mutable would move that hole one table
-- over: nobody would rewrite the intent, they would rewrite the entry zone
-- and the exit price the intent is revalidated against, and the gate would
-- go on reporting success while judging a band nobody approved.
--
-- Its own function rather than `vigil_candidate_append_only()`, which
-- enforces the same shape on `candidates`: that message tells the reader to
-- append a `candidate_evaluations` row, and a position plan has no
-- evaluations. The correction path here is a different one — a changed
-- thesis is a new plan under a new id, executed by a new authorization —
-- and a refusal that named the wrong one would send an operator to a table
-- that cannot hold what they are trying to record.
--
-- Row-level triggers do not fire for TRUNCATE, so an integration suite can
-- still reset its own tables between cases. Nothing in the application ever
-- truncates them.
CREATE FUNCTION vigil_position_plan_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'position plan terms are append-only: a changed thesis is a new plan under a new id, executed by a new authorization (attempted % on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER position_plans_append_only
  BEFORE UPDATE OR DELETE ON "position_plans"
  FOR EACH ROW EXECUTE FUNCTION vigil_position_plan_append_only();
