-- Append-only guard for the journal.
--
-- A posted journal entry is a statement about what this application
-- believed, and when. Correcting one means posting a reversing entry and
-- then the corrected entry, so both the mistake and the correction survive
-- (AGENTS.md "Database changes"; docs/architecture.md record family
-- `journal`). @vigil/ledger exports no function that edits or deletes an
-- entry — this trigger is what makes that a property of the database rather
-- than a property of the current application code.
--
-- Row-level triggers do not fire for TRUNCATE, so an integration suite can
-- still reset its own tables between cases. Nothing in the application ever
-- truncates them.
--
-- `ledger_balances` is deliberately NOT guarded: it is a projection of the
-- journal and is updated in place on every posting.
CREATE FUNCTION vigil_journal_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'journal rows are append-only: correct a posted entry with a reversing entry (attempted % on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION vigil_journal_append_only();
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION vigil_journal_append_only();
