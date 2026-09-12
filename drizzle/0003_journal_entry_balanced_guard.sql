-- Every journal entry balances, per asset, enforced at commit.
--
-- The invariant is @vigil/ledger's (`validateEntry`), but the layer graph
-- forbids packages/db from importing it, so until this migration the only
-- thing standing between an unbalanced entry and the tables was a caller
-- choosing to use the ledger. `postJournalEntry` now re-checks the sums in
-- bigint before writing; this is the half that holds for a writer which does
-- not go through it.
--
-- Deferred to commit on purpose: the postings of one entry arrive as
-- separate rows, so an immediate check would fire on the first line of every
-- entry and reject all of them. The trigger is attached to both tables
-- because they can be written apart — journal_lines carries a foreign key to
-- journal_entries, so a later transaction could otherwise add a single
-- unbalanced posting to an entry that was already balanced when it was
-- written.
--
-- Row-level triggers do not fire for TRUNCATE, so an integration suite can
-- still reset its own tables.
CREATE FUNCTION vigil_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  posting_count bigint;
  offending record;
BEGIN
  SELECT count(*) INTO posting_count
    FROM journal_lines
   WHERE entry_id = NEW.entry_id;

  IF posting_count < 2 THEN
    RAISE EXCEPTION
      'journal entry % has % postings; a double-entry posting has at least two',
      NEW.entry_id, posting_count
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;

  SELECT line.asset_id AS asset_id,
         sum(CASE WHEN line.direction = 'debit' THEN line.amount_base ELSE 0 END) AS debits,
         sum(CASE WHEN line.direction = 'credit' THEN line.amount_base ELSE 0 END) AS credits
    INTO offending
    FROM journal_lines line
   WHERE line.entry_id = NEW.entry_id
   GROUP BY line.asset_id
  HAVING sum(CASE WHEN line.direction = 'debit' THEN line.amount_base ELSE 0 END)
      <> sum(CASE WHEN line.direction = 'credit' THEN line.amount_base ELSE 0 END)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'journal entry % does not balance for asset %: debits % against credits %',
      NEW.entry_id, offending.asset_id, offending.debits, offending.credits
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vigil_journal_entry_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vigil_journal_entry_balanced();
