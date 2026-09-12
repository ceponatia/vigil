-- Balance per (asset, scale), not per asset.
--
-- 0003 grouped an entry's postings by `asset_id` alone, so a debit of 1 unit
-- at scale 6 and a credit of 1 unit at scale 18 summed to zero and committed
-- as "balanced" — two amounts that differ by a factor of a trillion. The
-- `asset_scales` registry added in 0004 makes that unrepresentable through
-- the foreign keys, and this regroups the guard to agree with it: if the
-- registry is ever relaxed, the balance rule does not quietly relax with it.
--
-- `CREATE OR REPLACE FUNCTION` keeps both constraint triggers from 0003
-- pointing at the new body; neither trigger is recreated.
CREATE OR REPLACE FUNCTION vigil_journal_entry_balanced() RETURNS trigger
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
         line.asset_scale AS asset_scale,
         sum(CASE WHEN line.direction = 'debit' THEN line.amount_base ELSE 0 END) AS debits,
         sum(CASE WHEN line.direction = 'credit' THEN line.amount_base ELSE 0 END) AS credits
    INTO offending
    FROM journal_lines line
   WHERE line.entry_id = NEW.entry_id
   GROUP BY line.asset_id, line.asset_scale
  HAVING sum(CASE WHEN line.direction = 'debit' THEN line.amount_base ELSE 0 END)
      <> sum(CASE WHEN line.direction = 'credit' THEN line.amount_base ELSE 0 END)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'journal entry % does not balance for asset % at scale %: debits % against credits %',
      NEW.entry_id, offending.asset_id, offending.asset_scale, offending.debits, offending.credits
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;

  RETURN NULL;
END;
$$;
