---
name: vigil-board-audit
description: Audit a filed batch of Vigil issues against the Vigil Development board and fill what the filer missed — board membership, Status, Horizon, Phase, Area, Priority, labels, parent and blocked-by relations, and the assignment convention. Use once after a whole filing batch completes, or on request for a board sweep after closures or reclassification; never per issue, never for filing, and never for body edits.
---

# Audit a batch on the board

This skill runs **once per batch**, after every issue the filing brief named
exists — not each time one issue lands — and again whenever the parent asks
for a board sweep (a dependency closed, a reclassification, a suspicion that
fields drifted). `vigil-board` owns the helpers that write to the board and
the field vocabulary; `vigil-docs` owns issue bodies. This skill owns the
comparison between what the board holds and what the issues say, and the
rules for filling a gap. On Claude the `vigil-board-auditor` role (Sonnet)
follows it.

## What the parent supplies

- **The batch:** issue numbers, a parent issue whose sub-issues form the
  batch (`--parent N`), or a creation timestamp (`--since`). Prefer the exact
  numbers the filer reported.
- **What is authorized:** filling unset classification fields and adding
  board membership is the ordinary authorization; repairing a relation the
  body names is included unless the brief withholds it. Reclassifying a set
  value, changing Status past what the blockers justify, and assigning or
  unassigning the owner each need the brief to say so.
- **Reclassifications the parent orders**, if any, as `#N Field Value`.

Without a batch there is nothing to audit; ask for it rather than sweeping the
whole repository.

## Procedure

1. **Snapshot, read-only.** From the repository root:

   ```bash
   python3 .agents/skills/vigil-board-audit/board-audit.py --parent 3
   python3 .agents/skills/vigil-board-audit/board-audit.py 12 13 14 --json
   ```

   It reads `.agents/skills/vigil-board/board.env` (or `$VIGIL_BOARD_ENV`)
   and refuses to run while a value reads `TODO(bootstrap)`. Exit 0 means no
   findings, 3 at least one finding, 78 unconfigured, 1 an API failure. Each
   finding carries a code, a severity, whether it is fixable, a derived
   suggestion with the rule behind it, and the exact helper command that
   applies it. The derivation rules and every code are in
   [derivation.md](references/derivation.md).

2. **Decide per finding.** A `finding` that is `fixable` and inside the
   authorization is applied. A `finding` that is not fixable (a label outside
   the taxonomy, a body missing a section, a Done on an open issue, an
   assignee outside the owner's turn) is reported to the parent with its
   detail. An `info` entry (a parent with Area unset, a Todo that could be
   Ready, a set value that disagrees with the derivation) is reported, never
   acted on, unless the brief ordered exactly that change.

3. **Apply through the helpers, in dependency order.** Fields:
   `.agents/skills/vigil-board/board-set.sh N Field Value …` (one call per
   issue can carry several pairs). Relations:
   `.agents/skills/vigil-board/file-issue.sh --issue N --parent P
   --blocked-by M`. Membership: `board-set.sh N` with no pairs. Never a raw
   GraphQL mutation, never `gh project`, never `gh issue edit --body`.

4. **Re-run the snapshot** and report the saved state, not the requested one.
   If a helper fails part-way, rerun the same command; the helpers are
   idempotent and resume by number. A finding that survives the second run is
   reported as open with the helper's error text.

## Rules

- Fill only what is unset. A set value is never overwritten on the auditor's
  own judgment; report the disagreement and let the parent reclassify.
- Never set **Done**: only verified, owner-confirmed acceptance moves an
  issue there, and a merged PR is not acceptance.
- Assign the owner only when the convention says the next action is theirs
  (`In review`, or a `decision-needed` issue waiting on a ruling); remove an
  assignee only with the brief's authorization.
- Never remove a label, edit a body, file or close an issue, or create a
  branch. Report body defects for `vigil-docs`; report missing issues for the
  filer.
- Critical is never derived. Priority defaults to Normal and rises to High
  only when the issue blocks two or more others in the batch.
- The audit is proportional: a batch of two issues gets a two-line report.
