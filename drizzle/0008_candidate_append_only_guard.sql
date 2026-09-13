-- Append-only guard for the decisions family.
--
-- A candidate is the record of what this application believed BEFORE the
-- outcome was known: the entry zone it would have bought in, the staged
-- plan, the invalidation price, and the quote it read (docs/evaluation.md
-- "Opportunity journal"). Editing one after the price moves turns the
-- opportunity journal into a record of what the application wishes it had
-- decided, which is precisely the failure the journal exists to prevent —
-- "a missed entry is WAIT or MISSED, never a rewritten BUY" (AGENTS.md).
-- A later judgement is an appended `candidate_evaluations` row, never an
-- edit here.
--
-- `candidate_tranches` is guarded with its parent: a plan whose tranches can
-- be rewritten is a rewritten plan, and the child table is where every
-- quantity actually lives.
--
-- `candidate_evaluations` is deliberately NOT guarded. Evaluations
-- accumulate — a candidate judged WAIT at one quote and MISSED an hour later
-- has two rows, and readers take the newest — so appending is already the
-- correction path. The maturation data docs/evaluation.md describes (P&L,
-- excursion, time to invalidation) is owned by a later slice, and a trigger
-- that slice would have to drop is worse than one it can add once the shape
-- is settled.
--
-- Row-level triggers do not fire for TRUNCATE, so an integration suite can
-- still reset its own tables between cases. Nothing in the application ever
-- truncates them.
CREATE FUNCTION vigil_candidate_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'candidate rows are append-only: a later judgement is a new candidate_evaluations row (attempted % on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER candidates_append_only
  BEFORE UPDATE OR DELETE ON "candidates"
  FOR EACH ROW EXECUTE FUNCTION vigil_candidate_append_only();
--> statement-breakpoint
CREATE TRIGGER candidate_tranches_append_only
  BEFORE UPDATE OR DELETE ON "candidate_tranches"
  FOR EACH ROW EXECUTE FUNCTION vigil_candidate_append_only();
