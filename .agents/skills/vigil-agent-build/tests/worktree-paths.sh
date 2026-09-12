#!/usr/bin/env bash
# Offline contract checks for worktree naming, main-checkout resolution, the
# pnpm store lookup, and cleanup lookup. No network, no real git remote.
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
MAIN="$TMP/repo"          # the main checkout git worktree list names first
SESSION="$TMP/session"    # the worktree the helper is invoked from
BIN="$TMP/bin"
LOG="$TMP/calls"
FAKE_HOME="$TMP/home"
mkdir -p "$MAIN" "$SESSION" "$BIN" "$FAKE_HOME"

cat >"$BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"

location=""
if [ "${1:-}" = -C ]; then location=$2; shift 2; fi
# git resolves a relative worktree path from -C, not from the caller's cwd.
resolve() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "${location:-$PWD}" "$1" ;; esac; }
case "${1:-}" in
  rev-parse)
    if [ "${2:-}" = --show-toplevel ]; then echo "$FAKE_ROOT"
    elif [ "${2:-}" = --short ]; then echo abc1234
    fi
    ;;
  fetch|prune) ;;
  show-ref)
    ref="${@: -1}"
    case "$ref" in
      refs/heads/vigil-builder/*) [ "${FAKE_BRANCH_EXISTS:-0}" = 1 ] ;;
      *) exit 1 ;;
    esac
    ;;
  worktree)
    shift
    case "${1:-}" in
      list)
        # Porcelain lists the main checkout first, then the other worktrees.
        [ "${FAKE_NO_WORKTREE_LIST:-0}" = 1 ] && exit 0
        printf 'worktree %s\nHEAD abc1234abc1234abc1234abc1234abc1234abcd\nbranch refs/heads/main\n\n' "$FAKE_MAIN"
        printf 'worktree %s\nHEAD def5678def5678def5678def5678def5678defa\nbranch refs/heads/vigil-builder/1-session\n\n' "$FAKE_ROOT"
        ;;
      add)
        shift
        if [ "${1:-}" = -b ]; then shift 2; fi
        mkdir -p "$(resolve "$1")"
        ;;
      remove)
        shift
        [ "${1:-}" = --force ] && shift
        rmdir "$(resolve "$1")"
        ;;
      prune) ;;
    esac
    ;;
  branch)
    if [ "${2:-}" = --show-current ]; then echo vigil-builder/42-feature; fi
    ;;
  status) ;;
esac
EOF

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = --worktree ]; then mkdir -p "$2"; exit 0; fi
  shift
done
EOF

cat >"$BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm-cwd %s\n' "$PWD" >>"$FAKE_LOG"
printf 'pnpm' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"
EOF
chmod +x "$BIN/git" "$BIN/gh" "$BIN/pnpm"

# Invoked from the session worktree: --show-toplevel is SESSION, not MAIN.
# VIGIL_BUILD_ENV points worktree-up.sh at a fixture repo name so the offline
# fixtures never depend on the real (not-yet-bootstrapped) repository.
run_up() {
  (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" VIGIL_BUILD_ENV="$SKILL_DIR/tests/build.env" \
    "$SKILL_DIR/worktree-up.sh" "$@")
}

run_down() {
  (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" "$SKILL_DIR/worktree-down.sh" "$@")
}

fail() { echo "$1" >&2; exit 1; }

output=$(run_up 42 feature --no-install)
grep -Fq "gh issue develop 42 --repo ceponatia/vigil-fixture --base main --name vigil-builder/42-feature --checkout --worktree $MAIN/.claude/worktrees/issue-42" "$LOG" \
  || fail "worktree-up did not target the main checkout"
! grep -Fq "$SESSION/.claude/worktrees" "$LOG" || fail "worktree-up nested the worktree in the invoking worktree"
grep -Fq "branch:   vigil-builder/42-feature @ abc1234" <<<"$output" || fail "worktree-up did not print the summary"
echo 'ok  worktree-up places the worktree under the main checkout from any checkout'

rm -rf "$MAIN/.claude"
: >"$LOG"
output=$(FAKE_BRANCH_EXISTS=1 run_up 42 feature --no-install)
grep -Fq "git -C $MAIN worktree add $MAIN/.claude/worktrees/issue-42 vigil-builder/42-feature" "$LOG" \
  || fail "worktree-up did not resume the existing branch's tip"
grep -Fq "re-created worktree at the existing tip of vigil-builder/42-feature" <<<"$output" \
  || fail "worktree-up did not report resuming the branch"
echo 'ok  worktree-up resumes an existing vigil-builder/<issue>-<slug> branch'

# No node_modules anywhere: the store lookup must fall through, not abort.
rm -rf "$MAIN/.claude"
: >"$LOG"
output=$(run_up 42 feature)
grep -Fq "node_modules linked offline from $FAKE_HOME/.local/share/pnpm/store" <<<"$output" \
  || fail "worktree-up did not fall back to the default store"
grep -Fq "pnpm install --offline --frozen-lockfile --store-dir $FAKE_HOME/.local/share/pnpm/store" "$LOG" \
  || fail "worktree-up did not run the offline install"
grep -Fq "worktree: $MAIN/.claude/worktrees/issue-42" <<<"$output" || fail "worktree-up did not print the summary after installing"
echo 'ok  worktree-up defaults the store and still summarizes without .modules.yaml'

# The main checkout's recorded store wins, with the /v<n> suffix stripped.
rm -rf "$MAIN/.claude"
mkdir -p "$MAIN/node_modules"
printf 'storeDir: %s/store/v10\nvirtualStoreDir: .pnpm\n' "$TMP" >"$MAIN/node_modules/.modules.yaml"
: >"$LOG"
output=$(run_up 42 feature)
grep -Fq "node_modules linked offline from $TMP/store" <<<"$output" || fail "worktree-up ignored the recorded store"
echo 'ok  worktree-up reads the main checkout store and strips the version suffix'

# Fallback when worktree list yields nothing (not a worktree-aware git).
rm -rf "$MAIN/.claude" "$MAIN/node_modules"
: >"$LOG"
output=$(FAKE_NO_WORKTREE_LIST=1 run_up 42 feature --no-install)
grep -Fq "worktree: $SESSION/.claude/worktrees/issue-42" <<<"$output" \
  || fail "worktree-up did not fall back to --show-toplevel"
echo 'ok  worktree-up falls back to --show-toplevel when the list is empty'

# A relative --dir belongs to the invoking worktree; every later call
# (`cd "$DIR"`, `git -C "$DIR"`) reads it from there, so the main-checkout
# `worktree add` must be handed the same absolute path.
rm -rf "$MAIN/.claude" "$SESSION/.claude" "$SESSION/relative-agent" "$MAIN/relative-agent"
: >"$LOG"
output=$(run_up 42 feature --slice --dir relative-agent)
grep -Fq "git -C $MAIN worktree add -b vigil-builder/42-feature $SESSION/relative-agent origin/main" "$LOG" \
  || fail "worktree-up did not make the relative --dir absolute for the main-checkout git call"
! grep -Fq "$MAIN/relative-agent" "$LOG" || fail "worktree-up created the relative --dir under the main checkout"
[ -d "$SESSION/relative-agent" ] || fail "worktree-up did not create the worktree in the invoking worktree"
grep -Fq "pnpm-cwd $SESSION/relative-agent" "$LOG" || fail "worktree-up installed outside the new worktree"
grep -Fq "worktree: $SESSION/relative-agent" <<<"$output" || fail "worktree-up did not summarize the absolute --dir"
grep -Fq "branch:   vigil-builder/42-feature @ abc1234" <<<"$output" || fail "worktree-up did not read the new worktree's HEAD"
echo 'ok  worktree-up pins a relative --dir to the invoking worktree'

# --slice never touches build.env, so an unconfigured repository does not block it.
rm -rf "$MAIN/.claude" "$SESSION/.claude" "$SESSION/relative-agent"
: >"$LOG"
output=$( (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" VIGIL_BUILD_ENV="$SKILL_DIR/build.env" \
    "$SKILL_DIR/worktree-up.sh" 42 feature --slice --no-install) )
grep -Fq "slice branch vigil-builder/42-feature" <<<"$output" || fail "worktree-up did not create the slice branch with an unconfigured repository"
echo 'ok  worktree-up --slice does not require VIGIL_BUILD_REPO'

# The default (linked) path fails clearly, not by guessing, when unconfigured.
rm -rf "$MAIN/.claude" "$SESSION/.claude"
: >"$LOG"
set +e
output=$( (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" VIGIL_BUILD_ENV="$SKILL_DIR/build.env" \
    "$SKILL_DIR/worktree-up.sh" 42 feature --no-install) 2>&1 )
status=$?
set -e
[ "$status" -eq 78 ] || fail "worktree-up did not exit 78 on an unconfigured repository (got $status)"
grep -Fq "not configured: set VIGIL_BUILD_REPO" <<<"$output" || fail "worktree-up did not name the missing config"
echo 'ok  worktree-up fails clearly instead of guessing the repository'

# Removal by issue number resolves under the main checkout too.
rm -rf "$SESSION/.claude"
mkdir -p "$MAIN/.claude/worktrees/issue-42"
: >"$LOG"
output=$(run_down 42)
grep -Fq "removed $MAIN/.claude/worktrees/issue-42" <<<"$output" || fail "worktree-down did not find the main-checkout worktree"
grep -Fq "kept branch vigil-builder/42-feature @ abc1234" <<<"$output" || fail "worktree-down did not keep the branch"
echo 'ok  worktree-down resolves an issue number under the main checkout'

# An explicit relative target (a sibling of the invoking worktree) must reach
# the main-checkout `worktree remove` as the same directory the checks saw.
rm -rf "$MAIN/.claude" "$SESSION/relative-agent"
mkdir -p "$TMP/sibling"
: >"$LOG"
output=$(run_down ../sibling)
grep -Fq "git -C $MAIN worktree remove $TMP/sibling" "$LOG" \
  || fail "worktree-down did not canonicalize the relative target for the main-checkout git call"
grep -Fq "removed $TMP/sibling" <<<"$output" || fail "worktree-down did not report the absolute path"
[ ! -d "$TMP/sibling" ] || fail "worktree-down left the sibling worktree in place"
echo 'ok  worktree-down canonicalizes a relative cleanup target'

echo "worktree path fixtures passed"
