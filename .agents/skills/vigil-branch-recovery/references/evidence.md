# Evidence and classification

Use this reference to audit stale branches and abandoned worktrees. Inspection
leaves the checkout unchanged; fetch updates refs and merge-tree can write Git
objects. Record full SHAs in the report; abbreviations are display aids only.

## Freeze the observation

From the shared checkout, record local state before refreshing remote refs:

```bash
git status --porcelain=v2 --branch --untracked-files=all
git worktree list --porcelain
git show-ref --dereference
git remote -v
```

For each worktree (this repository's convention is `.claude/worktrees/<slug>`),
use its path without entering or changing it:

```bash
git -C <worktree> rev-parse HEAD
git -C <worktree> branch --show-current
git -C <worktree> status --porcelain=v2 --branch --untracked-files=all
git -C <worktree> diff --stat HEAD
git -C <worktree> diff --cached --stat
```

An empty branch name means detached HEAD. Status output is evidence, not a reason
to clean or stash. If current remote state matters, record the source SHA first,
then `git fetch origin` without pruning; note any remote-tracking ref that moved.

If a branch or worktree disappeared, search without writing lost-found files or
expiring anything:

```bash
git reflog show --all --date=iso
git fsck --no-reflogs --unreachable --no-progress
git cat-file -t <candidate-full-sha>
git show --stat --summary <candidate-full-sha>
```

Inspect candidates before creating the non-overwriting recovery ref described in
[recovery and cleanup](recovery-and-cleanup.md).

## Separate graph facts from content facts

Set `TIP` and `TARGET` to the full observed source and target SHAs, then
keep those values fixed during classification:

```bash
TIP=$(git rev-parse '<source>^{commit}')
TARGET=$(git rev-parse 'origin/main^{commit}')
git merge-base --is-ancestor "$TIP" "$TARGET"
git rev-list --left-right --count "$TARGET...$TIP"
git merge-base "$TARGET" "$TIP"
git diff --name-status "$TARGET...$TIP"
git diff --name-status "$TARGET..$TIP"
git cherry -v "$TARGET" "$TIP"
```

- A successful ancestry check proves graph containment. A failed check does not
  prove unique work because squash and rebase merges rewrite commit identity.
- Ahead/behind counts count graph commits, not undelivered behavior.
- Three-dot diff shows source-side changes since the merge base. Two-dot diff
  compares current trees and can include later target edits as apparent removals.
- `git cherry` and `--cherry-pick` use patch equivalence. They can miss squashes,
  conflict resolutions, renames, binary changes, reordered commits, and later
  rewrites. Use them as supporting evidence only.

## Bind merged PR evidence to the source

Run from the repository's working tree so `gh` resolves the configured
repository; search all PR states by exact branch name, then inspect each
candidate:

```bash
gh pr list --state all --head '<branch>' --limit 100 \
  --json number,state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,url
gh pr view <pr> \
  --json number,state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,url
gh api --paginate "repos/$VIGIL_BOARD_REPO/pulls/<pr>/commits" --jq '.[].sha'
gh api --paginate "repos/$VIGIL_BOARD_REPO/pulls/<pr>/files" \
  --jq '.[] | [.status,.filename,.previous_filename] | @tsv'
```

`gh api` needs the repository spelled out in the path — it does not infer one
from the working tree the way plain `gh pr`/`gh issue` subcommands do. Source
[vigil-board](../../vigil-board/board.env)'s `board.env` (or
[vigil-pr-review](../../vigil-pr-review/review.env)'s `review.env`) for the
configured `owner/name` rather than typing it by hand.

Require the PR's full `headRefOid` to match the source tip being classified, or
separately classify commits added after that PR head. Confirm `state == MERGED`,
the merge commit exists, and that merge commit is an ancestor of the current
target. An open or closed-unmerged PR is provenance, not delivery evidence.
Verify the PR head object with `git cat-file -e "$PR_HEAD^{commit}"`; if it is
missing, preserve a fetched PR head under a new `refs/recovery/` ref before
running local tree comparisons.

For an ordinary merge, prove the PR head is reachable from the merge commit. For
a one-parent squash candidate, compare at merge time rather than against today's
`main`: inspect the merge commit's parent and tree, then run
`git merge-tree --write-tree "$MERGE^" "$PR_HEAD"` without checking anything out.
An identical resulting tree is strong evidence that the exact PR head produced
the squash tree. A conflict, unavailable object, or tree mismatch requires full
diff inspection; do not replace it with patch-id alone. Rebase merges likewise
need PR-head, per-commit, tree, and semantic evidence because identities changed.

## Inspect what happened after delivery

List the PR's changed paths and inspect target history after its merge:

```bash
git diff --name-status "$MERGE..$TARGET" -- path/to/changed-file
git log --oneline --decorate --ancestry-path "$MERGE..$TARGET" -- path/to/changed-file
git log -p "$MERGE..$TARGET" -- path/to/changed-file
```

Repeat for, or append, every changed path reported by the PR.

A current tree mismatch may be a later fix, refactor, rename, or deliberate
revert. Identify the responsible commits and compare behavior, tests, contracts,
and durable docs. "The file exists on main" does not prove that the source's
behavior survived, while "the old lines are absent" does not prove the behavior
was lost.

## Evidence table

Report one row per source:

| Source ref/worktree | Recorded tip | Dirty/untracked | Graph result | PR/head/merge | Merge-time content proof | Later target edits or reverts | Classification | Proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Treat missing objects, ambiguous PR heads, unexplained tree differences, and
conflicting signals as **Indeterminate**. Preserve first and investigate rather
than rounding uncertainty toward deletion.
