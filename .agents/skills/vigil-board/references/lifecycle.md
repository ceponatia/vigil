# Issue and PR lifecycle

Work starts at the issue, not at the branch. The order below is what makes the
PR link itself and carry the issue's classification.

**1. Take the issue.** Move it to **In progress**:

```bash
.agents/skills/vigil-board/board-set.sh 254 Status "In progress"
```

If the work has no issue, file one first (`vigil-docs` owns what goes in it —
the repository's issue template mirrors the handoff's Outcome / Context and
authoritative requirements / Scope / Out of scope / Dependencies / Acceptance
criteria / Verification / Safety-cost-boundary structure; `file-issue.sh`
below does the mechanics). A PR with no issue has nothing to inherit and has
to be classified by hand.

**2. Branch from the issue.** Never open with a bare `git checkout -b`:

```bash
gh issue develop 254 --base main --name vigil-builder/254-short-slug --checkout
```

Run from the repository's working tree so `gh` resolves the configured
repository on its own; the helpers in this skill instead read the repository
explicitly from `board.env` so they work from any cwd, including a worktree
under `.claude/worktrees/`.

This registers a **linked branch** on the issue. A PR opened from that branch
is connected to the issue with no keyword needed — and that connection is a
**closing** link. So `gh issue develop` is for a PR that delivers the **whole**
issue. If the PR delivers only a slice, branch the ordinary way
(`git switch -c vigil-builder/254-…`) and link nothing — an auto-close would
erase the remaining owed scope. Use conventional commits throughout.

**3. Open the PR draft.** Draft PRs run no CI, so stay draft while iterating
and mark the PR ready when the head is worth a run.

```bash
gh pr create --draft --base main --title "…" --body-file <body.md>
```

The body says `Closes #254` for a whole issue, `Part of #254` for a slice, and
names what is still owed. A branch made by `gh issue develop` already connects
the PR; the keyword is what carries the intent for a hand-made branch.

**4. Put the PR on the board and mirror the issue's classification.**

```bash
.agents/skills/vigil-board/link-pr.sh <pr-number> <issue-number>
```

It adds the PR if absent and copies **Horizon, Priority, Area, and Phase**
from the issue's item, clearing mirrored PR fields that are unset on the
issue. It reads the saved PR item back to verify both copies and clears. Run
it again whenever the issue is reclassified.

Do not assume linkage does this for you. GitHub documents no field inheritance
from a linked issue. Mirroring explicitly costs one command and is correct
either way.

**5. Status on the PR item tracks the PR, not the issue.** Set the PR status
from its actual lifecycle; do not rely on board automation's default:

| PR state | PR Status | Issue Status |
|---|---|---|
| draft, iterating | In progress | In progress |
| ready for owner review | In review, assign the owner | In review, assign the owner |
| merged | board automation may move it to Done — verify the saved result | Done only once the owner confirms the delivered behavior |

**Built is not accepted.** A merged PR does not prove runtime acceptance, and
for this repository it never proves live-trading readiness (handoff §14.3).
Only mark actual verified completion as Done; name the remaining acceptance
action on the issue otherwise and leave Status short of Done.

**A PR with no issue** (rare — it should have been filed first) is classified
by hand: `link-pr.sh` cannot help, so set the fields directly:
`board-set.sh <pr> --pr Horizon Next Priority High Area Data`.

## The assignment convention

**Assigned to the configured owner ⇔ the next action is the owner's.**
Anything assigned is, with certainty, ready for the owner to look at.
Everything else stays unassigned.

Assign the owner when — and only when — the next action requires the owner:

- an issue's Status becomes **In review** (built, waiting on owner
  verification, approval for a paid run, grading, or merge);
- built work is **ready for review** — the branch/PR exists and the next step
  is the owner reviewing, flipping a draft ready, or merging. Assign the PR
  itself too;
- an issue in **Needs decision** — a `decision-needed` item whose only unblock
  is an owner ruling.

Leave unassigned: Todo, Waiting on dependency, Ready, and In progress. "To be
implemented" work is never assigned.

When the owner acts — accepts, rules, merges — the assignment resolves itself:
the issue closes, or (if the ruling sends it back to implementation) **remove
the assignee** so the pool stays honest.

```bash
.agents/skills/vigil-board/board-set.sh <issue> Status "In review" --assign
.agents/skills/vigil-board/board-set.sh <pr> --pr Status "In review" --assign
.agents/skills/vigil-board/board-set.sh <issue> --unassign        # ruling sent it back to the pool
```

(`gh issue edit <n> --add-assignee <owner>` / `gh pr edit …` is what those run
underneath.)

## Authorization and acceptance

Existing task authorization controls who opens, readies, or merges a PR. If
the user authorized the action, carry it through without asking again; assign
the owner only when the next action really is theirs. Keep drafts while
iterating, and hand off the review/CI loop to `vigil-pr-review`. A skill does
not itself authorize external messages or closing unfinished scope.

Dependencies are native blocked-by links on the affected issue, and its Status
is **Waiting on dependency** while any linked blocker is open. If work is
blocked by an owner choice, use a `decision-needed` issue in **Needs
decision**, assigned to the owner. Do not use row order or narrative notes as
dependency records. `vigil-docs` owns issue contents.
