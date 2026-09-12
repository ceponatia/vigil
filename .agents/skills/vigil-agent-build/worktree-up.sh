#!/usr/bin/env bash
# Create the branch and worktree an agent builds in — from the issue, so the
# PR links itself.
#
#   worktree-up.sh <issue> <slug> [--slice] [--base main] [--dir path] [--no-install]
#
# Default: `gh issue develop` registers vigil-builder/<issue>-<slug> as a
# linked branch (a PR from it is a closing reference for the issue) and checks
# it out at the main checkout's .claude/worktrees/issue-<issue>, wherever the
# helper runs from. Use --slice when the branch will deliver only part of the
# issue: a plain local branch, no link, and the PR body says `Part of #N`. If
# the branch already exists (a corrections round after the worktree was
# removed) the worktree is re-created at its tip.
#
# Then node_modules are linked from the pnpm store — offline, frozen lockfile,
# about a second, no network and no build — so the agent's editor diagnostics
# are real and `pnpm db:generate` works there. --no-install skips it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=build.env
source "${VIGIL_BUILD_ENV:-$HERE/build.env}"

ISSUE="${1:?usage: worktree-up.sh <issue> <slug> [--slice] [--base main] [--dir path] [--no-install]}"
SLUG="${2:?slug required (short, kebab-case)}"; shift 2
SLICE=0; BASE=main; DIR=""; INSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --slice) SLICE=1; shift ;;
    --base) BASE="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done
# A relative --dir is resolved from the invoking cwd by the `cd "$DIR"` and
# `git -C "$DIR"` calls below, but `git -C "$ROOT" worktree add` would resolve
# it from the main checkout; pin it to one absolute path so both agree.
[ -z "$DIR" ] || [[ "$DIR" = /* ]] || DIR="$PWD/$DIR"
[[ "$ISSUE" =~ ^[0-9]+$ ]] || { echo "issue must be a number" >&2; exit 1; }

# A session worktree is not the repository root, so --show-toplevel would nest
# the new worktree inside it; `git worktree list` names the main checkout first.
ROOT=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') || ROOT=""
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
BRANCH="vigil-builder/$ISSUE-$SLUG"
DIR="${DIR:-$ROOT/.claude/worktrees/issue-$ISSUE}"
[ ! -e "$DIR" ] || { echo "$DIR already exists — worktree-down.sh $ISSUE first, or pass --dir" >&2; exit 1; }

git -C "$ROOT" fetch -q origin "$BASE"
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$ROOT" worktree add "$DIR" "$BRANCH"
  echo "re-created worktree at the existing tip of $BRANCH"
elif [ "$SLICE" = 1 ]; then
  git -C "$ROOT" worktree add -b "$BRANCH" "$DIR" "origin/$BASE"
  echo "slice branch $BRANCH (local only, not linked — the PR says 'Part of #$ISSUE')"
else
  case "$VIGIL_BUILD_REPO" in
    ''|'TODO(bootstrap)'*) echo "not configured: set VIGIL_BUILD_REPO in ${VIGIL_BUILD_ENV:-$HERE/build.env}" >&2; exit 78 ;;
  esac
  gh issue develop "$ISSUE" --repo "$VIGIL_BUILD_REPO" --base "$BASE" --name "$BRANCH" --checkout --worktree "$DIR"
  echo "linked branch $BRANCH registered on #$ISSUE (a PR from it closes the issue)"
fi

if [ "$INSTALL" = 1 ]; then
  # A fresh clone has no node_modules to read the store from; fall through to the
  # default rather than aborting after the worktree already exists.
  store=""
  if [ -f "$ROOT/node_modules/.modules.yaml" ]; then
    store=$(sed -n 's/^storeDir: //p' "$ROOT/node_modules/.modules.yaml" | sed 's#/v[0-9]*$##') || store=""
  fi
  store="${store:-$HOME/.local/share/pnpm/store}"
  (cd "$DIR" && pnpm install --offline --frozen-lockfile --store-dir "$store" >/dev/null) \
    && echo "node_modules linked offline from $store" \
    || echo "offline install failed (store $store) — the agent can still edit; diagnostics may be stale" >&2
fi

echo
echo "worktree: $DIR"
echo "branch:   $BRANCH @ $(git -C "$DIR" rev-parse --short HEAD)"
echo "agents work only inside that directory, commit by pathspec, never push, never open a PR."
