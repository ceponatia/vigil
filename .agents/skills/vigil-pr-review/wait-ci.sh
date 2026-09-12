#!/usr/bin/env bash
# Wait for the required CI aggregate on one immutable PR head.
#
#   wait-ci.sh <pr> [--timeout-min N] [--interval-sec N] [--max-errors N]
#
# Exit: 0 current-head required CI/verify succeeded; 1 verify failed/cancelled/
# skipped; 2 timed out; 3 draft; 4 conflicting; 5 repeated/API-invalid errors;
# 6 PR is no longer open.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=review.env
source "${VIGIL_REVIEW_ENV:-$HERE/review.env}"

require_config() {
  local var="$1"
  local val="${!var:-}"
  case "$val" in
    ''|'TODO(bootstrap)'*) echo "not configured: set $var in ${VIGIL_REVIEW_ENV:-$HERE/review.env}" >&2; exit 78 ;;
  esac
}
require_config VIGIL_REVIEW_REPO

REPO="$VIGIL_REVIEW_REPO"
PR="${1:?usage: wait-ci.sh <pr> [--timeout-min N] [--interval-sec N] [--max-errors N]}"
shift
TIMEOUT=25
INTERVAL=30
MAX_ERRORS=3

need_value() {
  [ "$#" -ge 2 ] || { echo "$1 requires a value" >&2; exit 64; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-min) need_value "$@"; TIMEOUT="$2"; shift 2 ;;
    --interval-sec) need_value "$@"; INTERVAL="$2"; shift 2 ;;
    --max-errors) need_value "$@"; MAX_ERRORS="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 64 ;;
  esac
done
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "--timeout-min must be a non-negative integer" >&2; exit 64; }
[[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]] || { echo "--interval-sec must be a positive integer" >&2; exit 64; }
[[ "$MAX_ERRORS" =~ ^[1-9][0-9]*$ ]] || { echo "--max-errors must be a positive integer" >&2; exit 64; }

view_pr() {
  gh pr view "$PR" --repo "$REPO" --json state,isDraft,mergeable,headRefOid,url
}

check_pr_state() {
  local data=$1
  local state draft mergeable
  state=$(jq -r .state <<<"$data")
  draft=$(jq -r .isDraft <<<"$data")
  mergeable=$(jq -r .mergeable <<<"$data")
  [ "$state" = OPEN ] || { echo "PR is $state — required CI was not verified"; exit 6; }
  [ "$draft" != true ] || { echo "draft PRs run no CI — mark it ready when authorized before waiting"; exit 3; }
  [ "$mergeable" != CONFLICTING ] || { echo "CONFLICTING — no merge ref, so CI never triggers; merge main into the branch first"; exit 4; }
}

if ! initial=$(view_pr); then
  echo "could not read PR #$PR" >&2
  exit 5
fi
check_pr_state "$initial"
head=$(jq -r .headRefOid <<<"$initial")
[[ "$head" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "invalid PR head SHA: $head" >&2; exit 5; }
echo "PR #$PR $(jq -r .url <<<"$initial")  head=$head mergeable=$(jq -r .mergeable <<<"$initial")"

deadline=$(( $(date +%s) + TIMEOUT * 60 ))
errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT
errors=0

while :; do
  : >"$errfile"
  set +e
  checks=$(gh pr checks "$PR" --repo "$REPO" --required \
    --json name,bucket,state,workflow,event,link 2>"$errfile")
  checks_rc=$?
  set -e
  checks_err=$(cat "$errfile")

  # gh deliberately returns 8 while checks are pending and 1 when they fail.
  # Both can carry complete JSON and must be parsed rather than discarded.
  valid=0
  if [ "$checks_rc" -eq 0 ] || [ "$checks_rc" -eq 1 ] || [ "$checks_rc" -eq 8 ]; then
    if jq -e 'type == "array"' <<<"$checks" >/dev/null 2>&1; then valid=1; fi
  fi
  if grep -qi 'no checks reported' <<<"$checks_err$checks"; then
    checks='[]'
    valid=1
  fi

  if ! current=$(view_pr); then
    errors=$((errors + 1))
    echo "$(date +%H:%M:%S)  could not re-read PR head ($errors/$MAX_ERRORS)" >&2
  else
    check_pr_state "$current"
    current_head=$(jq -r .headRefOid <<<"$current")
    if [ "$current_head" != "$head" ]; then
      echo "new push: head $head -> $current_head; discarded checks read for the previous head"
      head=$current_head
      errors=0
    elif [ "$valid" -eq 0 ]; then
      errors=$((errors + 1))
      detail=${checks_err:-${checks:-empty result}}
      echo "$(date +%H:%M:%S)  gh pr checks rc=$checks_rc: $detail ($errors/$MAX_ERRORS)" >&2
    elif [ "$checks" = "[]" ]; then
      errors=0
      echo "$(date +%H:%M:%S)  no required checks registered for head $head — waiting"
    else
      errors=0
      verify=$(jq -c '[.[] | select(.name == "verify" and .workflow == "CI")]' <<<"$checks")
      verify_count=$(jq 'length' <<<"$verify")
      if [ "$verify_count" -gt 1 ] && jq -e 'any(.[]; .bucket == "skipping")' <<<"$verify" >/dev/null; then
        # A draft-triggered run's skipped verify can linger in the rollup until the
        # ready-triggered run creates its own verify check for the same head. Once a
        # newer CI/verify exists for this head, the superseded skip is not a failure —
        # drop it and judge readiness from the newer run's verify instead. A skipped
        # verify with no newer run present (verify_count == 1) still fails below.
        checks=$(jq -c '[.[] | select(.name != "verify" or .workflow != "CI" or .bucket != "skipping")]' <<<"$checks")
        verify=$(jq -c '[.[] | select(.name == "verify" and .workflow == "CI")]' <<<"$checks")
        verify_count=$(jq 'length' <<<"$verify")
      fi
      if jq -e 'any(.[]; .bucket == "fail" or .bucket == "cancel" or .bucket == "skipping")' <<<"$checks" >/dev/null; then
        echo "FAILED for head $head:"
        jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel" or .bucket == "skipping") | "  \(.state)\t\(.workflow)/\(.name)"' <<<"$checks"
        echo "diagnose with ci-failure.sh $PR (from logs, never a local gate run)"
        exit 1
      elif jq -e 'any(.[]; .bucket == "pending")' <<<"$checks" >/dev/null; then
        pending=$(jq -r '[.[] | select(.bucket == "pending") | (.workflow + "/" + .name)] | join(", ")' <<<"$checks")
        echo "$(date +%H:%M:%S)  required checks pending for head $head: $pending"
      elif [ "$verify_count" -eq 0 ]; then
        echo "$(date +%H:%M:%S)  required checks exist, but CI/verify is absent for head $head — waiting"
      elif jq -e 'all(.[]; .bucket == "pass" and .state == "SUCCESS")' <<<"$checks" >/dev/null \
        && jq -e 'all(.[]; .bucket == "pass" and .state == "SUCCESS")' <<<"$verify" >/dev/null; then
        echo "GREEN: required CI/verify succeeded for head $head"
        jq -r '.[] | "  \(.state)\t\(.workflow)/\(.name)\t\(.link)"' <<<"$checks"
        exit 0
      else
        state=$(jq -r 'map(.state) | join(",")' <<<"$verify")
        echo "$(date +%H:%M:%S)  CI/verify $state for head $head — waiting"
      fi
    fi
  fi

  [ "$errors" -lt "$MAX_ERRORS" ] || { echo "aborting after $MAX_ERRORS consecutive GitHub/API errors" >&2; exit 5; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out after $TIMEOUT min waiting for head $head"; exit 2; }
  sleep "$INTERVAL"
done
