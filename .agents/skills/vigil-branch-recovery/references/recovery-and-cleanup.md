# Recovery and cleanup

Read this after classification when content must be preserved, delivered, or
deleted. Recovery must leave the original refs and worktree unchanged until the
replacement is committed, reviewed, and accepted.

## Preserve working-tree state

For a dirty or abandoned worktree, create a private evidence directory outside
the repository and source worktree. Record its permissions and do not upload it;
untracked files can contain credentials. Set `WT` to the absolute worktree path
(this repository's convention is `.claude/worktrees/<slug>`) and use a
filesystem-safe source slug:

These archives preserve source data independently of the checkout being
recovered. Keep ordinary audit reports and evaluation output in `eval-output/`;
do not put the only recovery copy inside a worktree that may be removed.

```bash
WT=/absolute/path/to/.claude/worktrees/<slug>
SOURCE_SLUG=branch-name
RECOVERY_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/vigil/branch-recovery/$(date -u +%Y%m%dT%H%M%SZ)-$SOURCE_SLUG"
(umask 077; mkdir -p "$RECOVERY_DIR")
git -C "$WT" rev-parse HEAD > "$RECOVERY_DIR/head.txt"
git -C "$WT" branch --show-current > "$RECOVERY_DIR/branch.txt"
git -C "$WT" status --porcelain=v2 --branch --untracked-files=all > "$RECOVERY_DIR/status.txt"
git -C "$WT" diff --binary HEAD > "$RECOVERY_DIR/working-tree.patch"
git -C "$WT" diff --binary --cached > "$RECOVERY_DIR/index.patch"
git -C "$WT" ls-files --others --exclude-standard -z |
  tar -C "$WT" --null --verbatim-files-from -T - -czf "$RECOVERY_DIR/untracked.tar.gz"
tar -tzf "$RECOVERY_DIR/untracked.tar.gz" >/dev/null
```

Keep the original worktree in place. Verify that the patches and archive are
readable and hash the evidence files. A branch ref preserves committed history,
but it does not preserve staged, unstaged, or untracked content. Inventory
potentially relevant ignored source separately; do not archive dependency stores,
build output, or caches blindly.

For any named branch, a Git bundle provides independent committed-history
evidence in addition to the working-tree captures:

```bash
BRANCH=$(git -C "$WT" branch --show-current)
git -C "$WT" bundle create "$RECOVERY_DIR/source.bundle" "$BRANCH"
git -C "$WT" bundle verify "$RECOVERY_DIR/source.bundle"
```

For a detached or deleted tip found through reflog/fsck, create a namespaced
recovery ref at the exact full SHA before any cleanup or garbage collection.
The empty expected-old value makes creation fail rather than overwrite a ref
that appeared concurrently:

```bash
RECOVERY_REF="refs/recovery/$SOURCE_SLUG"
if git show-ref --verify --quiet "$RECOVERY_REF"; then
  echo "recovery ref already exists: $RECOVERY_REF" >&2
else
  git update-ref "$RECOVERY_REF" "$TIP" ''
fi
```

After all applicable captures, hash every evidence file except the checksum
manifest itself:

```bash
find "$RECOVERY_DIR" -maxdepth 1 -type f ! -name SHA256SUMS -print0 |
  sort -z | xargs -0 sha256sum > "$RECOVERY_DIR/SHA256SUMS"
```

## Deliver recovered work

1. Keep every original source ref and worktree.
2. Establish or reopen the issue that owns the behavior. Use `vigil-docs` for
   issue content and `vigil-board` for creation, relations, and lifecycle.
3. Use `vigil-agent-build` to create the new issue-linked worktree (under
   `.claude/worktrees/`) or partial slice. Port the unique behavior by
   reviewed commits or patches; do not merge an obsolete branch wholesale
   across conflicts.
4. Compare the recovered diff with the evidence inventory. Apply current
   architecture and durable docs rather than restoring superseded structure.
5. Deliver through a PR unless the user's authorization specifies another route.
   `vigil-pr-review` owns CI and review. No local application gate substitutes
   for that evidence.
6. Retain the original and the private evidence until the recovered scope is
   merged and accepted.

When several stale branches overlap, map their commit, patch, and file relations
first. Choose a preserved source of truth and recover only unique deltas; do not
stack every branch and call conflicts proof that all content is needed.

## Perform authorized cleanup

Prepare the evidence table and exact deletion list before acting. If the user
authorized those refs/worktrees or a clearly defined cleanup class and the
evidence matches that scope, proceed without asking again. For example, "delete
stale local branches whose work landed" authorizes deletion of sources proven to
meet that condition. Ask only when the proposed action exceeds that scope or a
material ambiguity prevents safe classification; an audit alone grants no deletion.

Immediately before cleanup:

- re-read every full ref SHA and abort if it differs from the recorded value;
- re-read worktree status, including untracked files, and refuse dirty removal;
- confirm no worktree is using a branch before deleting it;
- distinguish local branch deletion, remote branch deletion, and worktree removal
  as separate actions; authorization for one does not imply the others;
- keep recovery evidence until the accepted delivery or explicit evidence cleanup.

Normal worktree removal may use the `vigil-agent-build` helper after these
checks. Never pass `--force` merely because a worktree is inconvenient. `git branch -d`
will reject many squash-delivered branches because graph ancestry is absent; use
force deletion only for a specifically authorized ref whose full SHA and
classification were just revalidated. Never delete from ahead/behind counts,
merged-PR state alone, or patch-id alone.
