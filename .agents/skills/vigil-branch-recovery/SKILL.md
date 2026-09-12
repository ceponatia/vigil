---
name: vigil-branch-recovery
description: Classify and recover stale Vigil branches or abandoned worktrees. Use for suspected lost work before cleanup; ordinary worktree creation belongs to vigil-agent-build.
---

# Recover Vigil branch work

Preserve the source first, determine whether its behavior reached the target,
then recover or clean up. Existing user scope and authorization remain in force.
An audit or cleanup proposal does not itself authorize deletion. A request to
delete named refs or a clearly defined class, such as proven-delivered stale
local branches, does; apply that existing scope without another confirmation.

## Protect the source

- Work from the current shared checkout with `git -C <path>`. Do not switch its
  branch, stash, reset, clean, or alter its index or working tree.
- Inventory every source ref and worktree at its full SHA (this repository's
  worktrees live under `.claude/worktrees/`). A dirty worktree, untracked
  source file, detached commit, missing object, or moving ref blocks cleanup
  until preserved.
- Do not remove a worktree, delete a branch, expire reflogs, prune unreachable
  objects, or force anything during classification.

Read [evidence and classification](references/evidence.md) and produce its
evidence table. Being ahead of `main`, a squash label, a merged PR, or patch-id
equivalence alone never proves that cleanup is safe.

## Classify before acting

Classify each source as one of:

- **Graph-contained:** its tip is an ancestor of the target and no worktree state
  exists outside the ref.
- **Squash/rebase delivered:** a merged PR is bound to the exact source head and
  independent tree, diff, and current-upstream evidence shows its behavior landed.
- **Delivered, then changed or reverted:** the PR landed, but later target commits
  replaced or removed some behavior. Determine whether that later change was
  intentional before proposing recovery or cleanup.
- **Superseded:** a later implementation owns the same behavior despite different
  patches. This requires semantic inspection and a cited owner or repository rule.
- **Unique/recoverable:** committed or working-tree content is absent from the
  target, including conflict-prone work that needs a fresh delivery path.
- **Indeterminate:** evidence is missing or contradictory. Preserve it and stop
  short of cleanup.

Read [recovery and cleanup](references/recovery-and-cleanup.md) for dirty state,
detached commits, recovery delivery, or an authorized deletion. Ordinary new
worktree creation remains in `vigil-agent-build`; `vigil-board` owns issue and
PR linkage, and `vigil-pr-review` owns CI and review.

## Finish truthfully

Before cleanup or any needed destructive approval, assemble the source path/ref, recorded SHA,
dirty and untracked state, merged-PR evidence, graph result, squash/rebase proof,
later upstream changes, classification, and exact proposed action. Re-read the
ref and worktree immediately before an authorized cleanup and abort if either
changed. Do not run this repository's local application tests, lint, typecheck,
or builds; recovered code follows the repository's CI workflow.
