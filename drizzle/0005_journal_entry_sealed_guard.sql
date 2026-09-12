-- A posted entry is sealed: no later transaction may add postings to it.
--
-- The append-only guard in 0001 blocks UPDATE and DELETE, which left the
-- third way to change a posted entry open: INSERT. `journal_lines` carries a
-- foreign key to `journal_entries`, so a second transaction could add two
-- offsetting postings to an entry that was committed days earlier. The pair
-- balances, so the deferred balance guard in 0003 passes; the entry's
-- meaning changes retroactively; and because the insert never went through
-- `postJournalEntry`, `ledger_balances` is never updated — the journal and
-- its projection now disagree, and a replay produces different balances than
-- the ones the application has been trading against.
--
-- The test is whether the entry row was written by the transaction now
-- adding the posting. `xmin` is the transaction that inserted the entry row;
-- comparing it to `pg_current_xact_id()` answers "did we write this entry
-- ourselves, moments ago?" — the only case in which a posting may still be
-- added.
--
-- Known limitation, deliberately accepted: a row inserted inside a
-- SAVEPOINT carries the subtransaction's id, which does not equal the
-- top-level `pg_current_xact_id()`. No store path uses savepoints; one that
-- did would have to seal entries with an explicit marker instead.
--
-- Row-level triggers do not fire for TRUNCATE, so a suite can still reset.
CREATE FUNCTION vigil_journal_lines_entry_sealed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_writer xid;
BEGIN
  SELECT entry.xmin INTO entry_writer
    FROM journal_entries entry
   WHERE entry.entry_id = NEW.entry_id;

  -- Not found: the foreign key rejects this row on its own, with a better
  -- message than anything this trigger could raise.
  IF FOUND AND entry_writer <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION
      'journal entry % was posted by an earlier transaction; a posted entry is sealed and corrections are reversing entries',
      NEW.entry_id
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_entry_sealed
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION vigil_journal_lines_entry_sealed();
