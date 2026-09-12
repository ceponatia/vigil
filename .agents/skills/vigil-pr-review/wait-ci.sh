#!/usr/bin/env bash
# Wait for the required CI aggregate on one immutable PR head.
#
#   wait-ci.sh <pr> [--timeout-min N] [--interval-sec N] [--max-errors N]
#
# Which CI/verify counts is decided by the workflow runs for the head, not by
# the checks rollup alone: the rollup holds exactly one entry per check name
# and REPLACES it, so between marking a PR ready and the ready-triggered run
# registering its own verify, the only CI/verify on the head is the draft
# run's SKIPPED (or concurrency-CANCELLED) one. A CI/verify belonging to any
# run older than the newest CI run for the head is superseded: it is dropped
# and the helper keeps waiting. A CI/verify belonging to the newest run — a
# lone skip with nothing newer behind it included — decides.
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
  # gh's --required wording differs from its bare form: "no required checks
  # reported on the '<branch>' branch" vs "no checks reported on the '<branch>'
  # branch". Match both, or the transient pre-registration window (right after
  # a push, before any check has registered) burns the error budget instead of
  # routing to the "no required checks registered … — waiting" path below.
  if grep -qiE "no (required )?checks reported" <<<"$checks_err$checks"; then
    checks='[]'
    valid=1
  fi

  # The workflow runs for the same head, read in the same breath as the rollup.
  # The rollup alone cannot distinguish a superseded verify from a lone one, so
  # an unreadable run list is an error against the budget, not a licence to
  # fall back to a rule already known to be wrong.
  : >"$errfile"
  set +e
  runs=$(gh run list --repo "$REPO" --commit "$head" --limit 20 \
    --json databaseId,status,conclusion,createdAt,workflowName,event,headSha 2>"$errfile")
  runs_rc=$?
  set -e
  runs_err=$(cat "$errfile")
  runs_valid=0
  if [ "$runs_rc" -eq 0 ] && jq -e 'type == "array"' <<<"$runs" >/dev/null 2>&1; then runs_valid=1; fi

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
    elif [ "$runs_valid" -eq 0 ]; then
      errors=$((errors + 1))
      detail=${runs_err:-${runs:-empty result}}
      echo "$(date +%H:%M:%S)  gh run list rc=$runs_rc: $detail ($errors/$MAX_ERRORS)" >&2
    else
      errors=0
      # The newest CI run for this head is the one whose verify is authoritative.
      # ci-failure.sh picks the newest NON-skipped run because a skipped run has
      # no logs to read; here a skipped run must stay eligible, or a lone skipped
      # verify with nothing newer behind it would silently become a wait instead
      # of the exit 1 this helper's contract promises. createdAt ties are broken
      # by databaseId, which GitHub allocates in order.
      newest=$(jq -r --arg head "$head" '
        [.[] | select(.workflowName == "CI" and .headSha == $head)]
        | sort_by(.createdAt, .databaseId) | last
        | if . == null then "" else "\(.databaseId) \(.status) \(.conclusion // "-")" end' <<<"$runs")
      newest_id=""; newest_status=""; newest_conclusion=""
      read -r newest_id newest_status newest_conclusion <<<"$newest" || true
      # Empty when no CI run exists for this head yet; anything non-numeric would
      # be a malformed run list, which is the same absence of usable evidence.
      [[ "$newest_id" =~ ^[0-9]+$ ]] || newest_id=""
      run_note=""
      [ -z "$newest_id" ] || run_note=" (newest CI run $newest_id: $newest_status/${newest_conclusion:--})"

      raw_count=$(jq 'length' <<<"$checks")
      if [ -n "$newest_id" ]; then
        # A check run's link is its own job URL, .../actions/runs/<run>/job/<job>,
        # so the run it belongs to is readable from the rollup entry itself. A
        # CI/verify from any older run is superseded and dropped; one that names
        # no run cannot be attributed and is dropped too, which keeps waiting
        # rather than reporting a green the evidence does not support. Only
        # CI/verify is ever dropped — another workflow's required check is never
        # superseded by a CI run.
        checks=$(jq -c --arg run "$newest_id" '
          [.[] | select((.name != "verify" or .workflow != "CI")
                        or ((.link // "") | test("/runs/" + $run + "(/|$)")))]' <<<"$checks")
      fi
      verify=$(jq -c '[.[] | select(.name == "verify" and .workflow == "CI")]' <<<"$checks")
      verify_count=$(jq 'length' <<<"$verify")

      if [ "$raw_count" -eq 0 ]; then
        echo "$(date +%H:%M:%S)  no required checks registered for head $head$run_note — waiting"
      elif jq -e 'any(.[]; .bucket == "fail" or .bucket == "cancel" or .bucket == "skipping")' <<<"$checks" >/dev/null; then
        echo "FAILED for head $head$run_note:"
        jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel" or .bucket == "skipping") | "  \(.state)\t\(.workflow)/\(.name)"' <<<"$checks"
        # The one window this rule cannot close from a single read: the newest CI
        # run for the head is itself a draft-guarded (skipped) or cancelled run,
        # which is also what the head looks like in the seconds between marking a
        # PR ready and GitHub creating the ready-triggered run. The verdict stays
        # the documented exit 1 — this helper never invents a run it cannot see —
        # but say so, because re-reading resolves it and nothing else will.
        if { [ "$newest_conclusion" = skipped ] || [ "$newest_conclusion" = cancelled ]; } \
          && jq -e 'any(.[]; .name == "verify" and .workflow == "CI"
                           and (.bucket == "skipping" or .bucket == "cancel"))' <<<"$checks" >/dev/null; then
          echo "note: run $newest_id is the newest CI run for this head and its jobs did not run."
          echo "      If this PR was just marked ready, the ready-triggered run may not exist yet;"
          echo "      re-run wait-ci.sh before treating this as a real failure."
        fi
        echo "diagnose with ci-failure.sh $PR (from logs, never a local gate run)"
        exit 1
      elif jq -e 'any(.[]; .bucket == "pending")' <<<"$checks" >/dev/null; then
        pending=$(jq -r '[.[] | select(.bucket == "pending") | (.workflow + "/" + .name)] | join(", ")' <<<"$checks")
        echo "$(date +%H:%M:%S)  required checks pending for head $head: $pending"
      elif [ "$verify_count" -eq 0 ]; then
        if [ -n "$newest_id" ] && [ "$newest_status" = completed ] && [ "$newest_conclusion" != success ]; then
          # The newest CI run for this head has already finished and produced no
          # CI/verify of its own — the realistic shape is a run cancelled before
          # its verify job (which `needs` every other job) was ever scheduled.
          # A completed run cannot register a verify later, so waiting out the
          # timeout here is not fail-closed, it is a wasted timeout; report now.
          echo "FAILED for head $head$run_note:"
          echo "  no CI/verify was ever registered for the newest CI run"
          echo "diagnose with ci-failure.sh $PR (from logs, never a local gate run)"
          exit 1
        fi
        echo "$(date +%H:%M:%S)  CI/verify is absent for head $head$run_note — waiting"
      elif jq -e 'all(.[]; .bucket == "pass" and .state == "SUCCESS")' <<<"$checks" >/dev/null \
        && jq -e 'all(.[]; .bucket == "pass" and .state == "SUCCESS")' <<<"$verify" >/dev/null; then
        echo "GREEN: required CI/verify succeeded for head $head$run_note"
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
