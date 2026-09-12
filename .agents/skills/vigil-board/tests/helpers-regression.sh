#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SKILL=$(cd "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
ln -s "$HERE/mock-gh.sh" "$TMP/bin/gh"

state="$TMP/link-clear"
mkdir -p "$state"
output=$(PATH="$TMP/bin:$PATH" VIGIL_BOARD_ENV="$HERE/board.env" TEST_SCENARIO=link-clear TEST_STATE_DIR="$state" "$SKILL/link-pr.sh" 11 10)
grep -Fq 'Priority: cleared (unset on #10)' <<<"$output" || { echo "link-pr did not report the clear" >&2; exit 1; }
grep -Fq 'field=F_PRIORITY' "$state/calls" || { echo "link-pr did not target stale Priority" >&2; exit 1; }
[ "$(grep -Fc 'clearProjectV2ItemFieldValue' "$state/calls")" -ge 3 ] || { echo "link-pr did not issue the expected clears" >&2; exit 1; }
grep -Fq 'exactly mirrors #10' <<<"$output" || { echo "link-pr did not verify the result" >&2; exit 1; }
echo 'ok  link-pr clears and verifies missing source fields'

state="$TMP/file-create-fail"
mkdir -p "$state"
set +e
output=$(PATH="$TMP/bin:$PATH" VIGIL_BOARD_ENV="$HERE/board.env" TEST_SCENARIO=file-create-fail TEST_STATE_DIR="$state" "$SKILL/file-issue.sh" --title fixture --body body --status Todo 2>&1)
rc=$?
set -e
[ "$rc" -eq 42 ] || { echo "file-issue lost the classification failure status: $rc" >&2; exit 1; }
grep -Fq 'resume with --issue 99' <<<"$output" || { echo "file-issue did not report the resume command" >&2; exit 1; }
[ "$(tail -1 <<<"$output")" = 99 ] || { echo "file-issue did not print the created number last" >&2; exit 1; }
echo 'ok  file-issue reports a resumable partial create'

state="$TMP/file-resume"
mkdir -p "$state"
output=$(PATH="$TMP/bin:$PATH" VIGIL_BOARD_ENV="$HERE/board.env" TEST_SCENARIO=file-resume TEST_STATE_DIR="$state" "$SKILL/file-issue.sh" --issue 99 --status Todo --parent 10 --blocked-by 20 --assign)
[ "$(tail -1 <<<"$output")" = 99 ] || { echo "resumed file-issue did not finish with the issue number" >&2; exit 1; }
! grep -Fq 'issue create' "$state/calls" || { echo "resume created a duplicate issue" >&2; exit 1; }
grep -Fq 'issues/99/assignees' "$state/calls" || { echo "resume lost owner assignment" >&2; exit 1; }
! grep -F ' -X POST ' "$state/calls" | grep -Eq 'sub_issues|dependencies/blocked_by' || { echo "resume repeated an existing relation" >&2; exit 1; }
grep -Fq 'already a sub-issue of #10' <<<"$output" || { echo "resume did not recognize existing parent relation" >&2; exit 1; }
grep -Fq 'already blocked by #20' <<<"$output" || { echo "resume did not recognize existing blocker relation" >&2; exit 1; }
echo 'ok  file-issue resumes without duplicates and preserves assignment'

# An unbootstrapped board.env (project id still a TODO placeholder) must fail
# clearly and immediately, before any gh call, rather than guessing an id.
state="$TMP/not-configured"
mkdir -p "$state"
set +e
output=$(PATH="$TMP/bin:$PATH" VIGIL_BOARD_ENV="$HERE/board-unconfigured.env" TEST_SCENARIO=not-configured TEST_STATE_DIR="$state" "$SKILL/board-set.sh" 5 Status Todo 2>&1)
rc=$?
set -e
[ "$rc" -eq 78 ] || { echo "board-set did not fail with the configuration exit code: rc=$rc" >&2; exit 1; }
grep -Fq "not configured: set VIGIL_BOARD_PROJECT_ID in $HERE/board-unconfigured.env" <<<"$output" \
  || { echo "board-set did not name the missing variable and file: $output" >&2; exit 1; }
[ ! -f "$state/calls" ] || { echo "board-set called gh before checking configuration" >&2; exit 1; }
echo 'ok  board-set fails clearly when the board is not configured'

# link-pr.sh reads the same board.env and must fail the same way, before ever
# calling gh, when the project id is still a placeholder.
state="$TMP/not-configured-link-pr"
mkdir -p "$state"
set +e
output=$(PATH="$TMP/bin:$PATH" VIGIL_BOARD_ENV="$HERE/board-unconfigured.env" TEST_SCENARIO=not-configured TEST_STATE_DIR="$state" "$SKILL/link-pr.sh" 11 10 2>&1)
rc=$?
set -e
[ "$rc" -eq 78 ] || { echo "link-pr did not fail with the configuration exit code: rc=$rc" >&2; exit 1; }
grep -Fq "not configured: set VIGIL_BOARD_PROJECT_ID in $HERE/board-unconfigured.env" <<<"$output" \
  || { echo "link-pr did not name the missing variable and file: $output" >&2; exit 1; }
[ ! -f "$state/calls" ] || { echo "link-pr called gh before checking configuration" >&2; exit 1; }
echo 'ok  link-pr fails clearly when the board is not configured'

echo 'all offline board-helper regressions passed'
