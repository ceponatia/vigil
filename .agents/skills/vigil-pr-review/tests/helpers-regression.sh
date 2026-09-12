#!/usr/bin/env bash
# Offline behavioral regressions for wait-ci.sh and review-status.sh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SKILL=$(cd "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
ln -s "$HERE/mock-gh.sh" "$TMP/bin/gh"
ln -s /usr/bin/true "$TMP/bin/sleep"

run_case() {
  local scenario=$1 expected_rc=$2 expected_text=$3 timeout=$5
  local state="$TMP/$scenario"
  mkdir -p "$state"
  set +e
  output=$(PATH="$TMP/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review.env" TEST_SCENARIO="$scenario" TEST_STATE_DIR="$state" "$SKILL/${4}" 1 --timeout-min "$timeout" --interval-sec 1 2>&1)
  rc=$?
  set -e
  if [ "$rc" -ne "$expected_rc" ] || ! grep -Fq "$expected_text" <<<"$output"; then
    printf 'FAIL %s: rc=%s, wanted rc=%s and %q\n%s\n' "$scenario" "$rc" "$expected_rc" "$expected_text" "$output" >&2
    exit 1
  fi
  printf 'ok  %s\n' "$scenario"
}

run_review() {
  local scenario=$1 expected=$2
  local state="$TMP/$scenario"
  mkdir -p "$state"
  output=$(PATH="$TMP/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review.env" TEST_SCENARIO="$scenario" TEST_STATE_DIR="$state" "$SKILL/review-status.sh" 1)
  if ! grep -Fq "review: $expected" <<<"$output"; then
    printf 'FAIL %s: wanted review: %s\n%s\n' "$scenario" "$expected" "$output" >&2
    exit 1
  fi
  grep -Fq -- '--paginate --slurp repos/ceponatia/vigil-fixture/issues/1/comments?per_page=100' "$state/calls" || {
    echo "FAIL $scenario: issue comments were not paginated" >&2
    exit 1
  }
  printf 'ok  %s\n' "$scenario"
}

# Valid JSON remains authoritative even with gh's documented rc=8/rc=1.
run_case wait-pending 0 'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1
# A draft-triggered run's skipped verify lingers in the rollup alongside the
# ready-triggered run's own verify for the same head (PR #12's actual shape at
# da96d76b: runs 34716578875 skipped, 34716584247 pending then success). The
# newer run's verify — not the superseded skip — decides pending vs. green.
run_case wait-draft-then-ready 0 'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1
run_case wait-failing 1 'FAILED for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 0
# Only a superseded skip is dropped. A lone skipped CI/verify — a draft run's
# verify with no newer run for this head — is still a failure; this kills a drop
# written without the "a newer CI/verify exists" guard, which would turn the
# documented exit 1 into an endless "CI/verify is absent" wait.
run_case wait-skipped-only 1 $'  SKIPPED\tCI/verify' wait-ci.sh 0
# Only CI/verify is superseded, and only for its own check. Beside the very
# draft-then-ready shape that triggers the drop, another workflow's skipped
# required check is still a failure; this kills a drop written on the bucket
# alone, which would report GREEN over a skipped required peer check.
run_case wait-peer-skipped 1 'Security/security' wait-ci.sh 0
# A draft run's verify left CANCELLED by the workflow's own
# concurrency: cancel-in-progress (the ready run starts while the draft run is
# still queued) is superseded the same way a skip is: the ready run's own
# verify decides pending vs. green.
run_case wait-draft-cancelled-then-ready 0 'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1
# An unrelated successful check cannot satisfy the required aggregate.
run_case wait-unrelated 2 'CI/verify is absent' wait-ci.sh 0
run_case wait-no-checks 2 'no required checks registered' wait-ci.sh 0
run_case wait-required-peer-fail 1 'Security/security' wait-ci.sh 0
# A successful sample is discarded when the full head changes during the read.
run_case wait-stale 2 'discarded checks read for the previous head' wait-ci.sh 0

run_review review-clean clean
run_review review-old-open-clean findings
run_review review-findings findings
run_review review-approved clean
run_review review-dismissed unverified
run_review review-pending pending
run_review review-legacy unverified
run_review review-impostor unverified
run_review review-trusted-reaction clean
run_review review-stale unverified
run_review review-unrequested unrequested

# --- configuration failures -------------------------------------------------

# An unbootstrapped review.env (repository still a TODO placeholder) must
# fail every helper clearly and immediately, before any gh call.
for helper in wait-ci.sh ci-failure.sh threads.sh reply-resolve.sh review-status.sh; do
  state="$TMP/not-configured-$helper"
  mkdir -p "$state"
  set +e
  output=$(PATH="$TMP/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review-unconfigured.env" TEST_SCENARIO=not-configured TEST_STATE_DIR="$state" \
    "$SKILL/$helper" 1 --body x 2>&1)
  rc=$?
  set -e
  [ "$rc" -eq 78 ] || { echo "FAIL $helper: did not fail with the configuration exit code: rc=$rc" >&2; exit 1; }
  grep -Fq "not configured: set VIGIL_REVIEW_REPO in $HERE/review-unconfigured.env" <<<"$output" \
    || { echo "FAIL $helper: did not name the missing variable and file: $output" >&2; exit 1; }
  [ ! -f "$state/calls" ] || { echo "FAIL $helper: called gh before checking configuration" >&2; exit 1; }
  printf 'ok  %s fails clearly when the repository is not configured\n' "$helper"
done

# A configured repository with no designated reviewer degrades only
# review-status.sh's final line — it must not fail the helper, and it must
# still report CI and threads, which do not need a reviewer identity.
state="$TMP/no-reviewer"
mkdir -p "$state"
output=$(PATH="$TMP/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review-no-reviewer.env" TEST_SCENARIO=review-unrequested TEST_STATE_DIR="$state" "$SKILL/review-status.sh" 1)
grep -Fq 'review: unverified — reviewer not configured (set VIGIL_REVIEWER_LOGIN in' <<<"$output" \
  || { echo "FAIL no-reviewer: did not report the degraded reviewer state: $output" >&2; exit 1; }
grep -Fq 'CI:' <<<"$output" || { echo "FAIL no-reviewer: CI section did not run" >&2; exit 1; }
grep -Fq 'threads: 0 total' <<<"$output" || { echo "FAIL no-reviewer: threads section did not run" >&2; exit 1; }
echo 'ok  review-status degrades to unverified without a configured reviewer, without failing'

# --- standing expectation for an open production defect ---------------------

# Two runs for the same head, both with a skipped CI/verify, and no live verify
# to supersede either. wait-ci.sh's own contract — its header, "1 verify failed/
# cancelled/skipped" — and the lone-skip case above both make this exit 1 naming
# the skipped verify. The supersede clause added in 7f6e138 instead drops EVERY
# skipped CI/verify once more than one verify exists, the newest included, so it
# reports "required checks exist, but CI/verify is absent for head" — false, two
# exist and both are skipped — and waits out the timeout for exit 2 instead.
# This expectation stands as the evidence for that defect and is not relaxed to
# match the code; the drop belongs behind "a non-skipped CI/verify exists".
run_case wait-verify-all-skipped 1 $'  SKIPPED\tCI/verify' wait-ci.sh 0

echo 'all offline helper regressions passed'
