#!/usr/bin/env bash
# Remove an agent worktree once its branch is merged into the integration
# branch. The branch is kept (corrections may need it) unless --delete-branch.
#
#   worktree-down.sh <issue | path> [--delete-branch] [--force]
#
# Refuses a worktree with uncommitted changes unless --force — an agent's
# unreported work would be lost.
set -euo pipefail

TARGET="${1:?usage: worktree-down.sh <issue|path> [--delete-branch] [--force]}"; shift
DELETE=0; FORCE=0
for a in "$@"; do
  case "$a" in --delete-branch) DELETE=1 ;; --force) FORCE=1 ;; *) echo "unknown flag $a" >&2; exit 1 ;; esac
done

# A session worktree is not the repository root, so a by-number lookup must use
# the main checkout; `git worktree list` names it first.
ROOT=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') || ROOT=""
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  DIR="$ROOT/.claude/worktrees/issue-$TARGET"
else
  DIR="$TARGET"
  # The checks below resolve a relative target from the invoking cwd, but
  # `git -C "$ROOT" worktree remove` resolves it from the main checkout; make
  # them name the same directory.
  if [ -d "$DIR" ]; then DIR=$(cd "$DIR" && pwd); fi
fi
[ -d "$DIR" ] || { echo "no worktree at $DIR" >&2; exit 1; }

branch=$(git -C "$DIR" branch --show-current || true)
if [ -n "$(git -C "$DIR" status --porcelain)" ] && [ "$FORCE" = 0 ]; then
  echo "$DIR has uncommitted changes:" >&2; git -C "$DIR" status --short >&2
  echo "commit them (or --force to discard)" >&2; exit 1
fi

if [ "$FORCE" = 1 ]; then git -C "$ROOT" worktree remove --force "$DIR"; else git -C "$ROOT" worktree remove "$DIR"; fi
git -C "$ROOT" worktree prune
echo "removed $DIR"

if [ -n "$branch" ]; then
  if [ "$DELETE" = 1 ]; then git -C "$ROOT" branch -D "$branch"; echo "deleted branch $branch"
  else echo "kept branch $branch @ $(git -C "$ROOT" rev-parse --short "$branch")"; fi
fi
