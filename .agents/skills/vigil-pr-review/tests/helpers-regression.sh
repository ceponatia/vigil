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
  local scenario=$1 expected_rc=$2 expected_text=$3 timeout=$5 also=${6:-}
  local state="$TMP/$scenario"
  mkdir -p "$state"
  set +e
  output=$(PATH="$TMP/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review.env" TEST_SCENARIO="$scenario" TEST_STATE_DIR="$state" "$SKILL/${4}" 1 --timeout-min "$timeout" --interval-sec 1 2>&1)
  rc=$?
  set -e
  if [ "$rc" -ne "$expected_rc" ] || ! grep -Fq "$expected_text" <<<"$output" \
    || { [ -n "$also" ] && ! grep -Fq "$also" <<<"$output"; }; then
    printf 'FAIL %s: rc=%s, wanted rc=%s and %q%s\n%s\n' "$scenario" "$rc" "$expected_rc" "$expected_text" \
      "${also:+ and $(printf '%q' "$also")}" "$output" >&2
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
# The live draft-then-ready sequence on PR #14 at head 72338c5, poll by poll.
# The checks rollup holds ONE entry per check name and replaces it, so while the
# ready-triggered run 34719267014 is in progress the only CI/verify on the head
# is still the draft run 34719260700's SKIPPED one — the shape that made this
# helper exit 1 on a PR whose CI went on to pass. The run list is the only
# source that separates it from a lone skip, so the helper must name the newer
# run and keep waiting, then go green on that run's own verify.
run_case wait-draft-then-ready 0 \
  'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1 \
  'CI/verify is absent for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (newest CI run 34719267014: in_progress/-)'
run_case wait-failing 1 'FAILED for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 0
# Only a superseded verify is dropped. A skipped CI/verify that belongs to the
# NEWEST CI run for the head — a draft-guarded run with nothing behind it — is
# still the documented exit 1; this kills a drop written on the bucket or on the
# rollup alone, which would turn that failure into an endless wait.
run_case wait-skipped-only 1 $'  SKIPPED\tCI/verify' wait-ci.sh 0
# Supersession is scoped to CI/verify and to its own workflow. Beside the very
# draft-then-ready shape that triggers the drop, another workflow's skipped
# required check is still a failure; this kills a drop written on the bucket
# alone, which would report GREEN over a skipped required peer check.
run_case wait-peer-skipped 1 'Security/security' wait-ci.sh 0
# A draft run's verify left CANCELLED by the workflow's own
# concurrency: cancel-in-progress (the ready run is created while the draft run
# is still queued) is superseded the same way a skip is: the ready run's own
# verify decides pending vs. green.
run_case wait-draft-cancelled-then-ready 0 'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1
# An unrelated successful check cannot satisfy the required aggregate.
run_case wait-unrelated 2 'CI/verify is absent' wait-ci.sh 0
run_case wait-no-checks 2 'no required checks registered' wait-ci.sh 0
run_case wait-required-peer-fail 1 'Security/security' wait-ci.sh 0
# A successful sample is discarded when the full head changes during the read.
run_case wait-stale 2 'discarded checks read for the previous head' wait-ci.sh 0
# Two draft-guarded runs for one head and nothing newer: the rollup carries the
# newer run's skipped verify (the older run's entry was replaced, not kept
# beside it) and no run supersedes it, so this stays the documented exit 1.
run_case wait-verify-all-skipped 1 $'  SKIPPED\tCI/verify' wait-ci.sh 0

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

# --- the run list is load-bearing, not advisory -----------------------------

# wait-ci.sh cannot tell a superseded verify from a lone one without the run
# list, so a run list it cannot read must spend the error budget and abort with
# the API exit code — never fall back to judging the rollup alone, which is the
# rule that produced the false red this suite exists to prevent.
state="$TMP/runs-unreadable"
mkdir -p "$state/bin"
ln -s "$HERE/mock-gh.sh" "$state/bin/gh-real"
cat >"$state/bin/gh" <<'SHIM'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "run list" ]; then
  echo 'HTTP 503: unavailable' >&2
  exit 1
fi
exec "$(dirname "$0")/gh-real" "$@"
SHIM
chmod +x "$state/bin/gh"
ln -s /usr/bin/true "$state/bin/sleep"
set +e
output=$(PATH="$state/bin:$PATH" VIGIL_REVIEW_ENV="$HERE/review.env" TEST_SCENARIO=wait-pending TEST_STATE_DIR="$state" \
  "$SKILL/wait-ci.sh" 1 --timeout-min 5 --interval-sec 1 --max-errors 2 2>&1)
rc=$?
set -e
[ "$rc" -eq 5 ] || { echo "FAIL runs-unreadable: rc=$rc, wanted 5" >&2; echo "$output" >&2; exit 1; }
grep -Fq 'gh run list rc=1' <<<"$output" || { echo "FAIL runs-unreadable: did not name the failing read: $output" >&2; exit 1; }
echo 'ok  wait-ci aborts on a repeatedly unreadable run list instead of judging the rollup alone'

echo 'all offline helper regressions passed'
