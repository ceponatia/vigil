#!/usr/bin/env bash
# List a PR's review threads with the ids the other scripts need.
#
#   threads.sh <pr> [--all] [--json]
#
# Default: unresolved threads only, readable. --all includes resolved ones.
# --json prints [{id, isResolved, isOutdated, path, line,
#                 comments: [{databaseId, author, body, url, createdAt}]}].
# The thread id (PRRT_…) is what resolveReviewThread wants; the first
# comment's databaseId is what the REST reply endpoint wants — reply-resolve.sh
# takes either.
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
require_config VIGIL_REVIEW_OWNER
require_config VIGIL_REVIEW_REPO

OWNER="$VIGIL_REVIEW_OWNER"
REPO_NAME="${VIGIL_REVIEW_REPO#*/}"

PR="${1:?usage: threads.sh <pr> [--all] [--json]}"; shift
ALL=0; JSON=0
for a in "$@"; do
  case "$a" in --all) ALL=1 ;; --json) JSON=1 ;; *) echo "unknown flag $a" >&2; exit 1 ;; esac
done

query='query($pr:Int!, $after:String) {
  repository(owner:"'"$OWNER"'", name:"'"$REPO_NAME"'") { pullRequest(number:$pr) {
    reviewThreads(first:100, after:$after) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated path line
        comments(first:50) { nodes { databaseId author { login } body url createdAt } } }
    } } } }'

acc='[]'; after=""
while :; do
  if [ -z "$after" ]; then page=$(gh api graphql -F pr="$PR" -f query="$query")
  else page=$(gh api graphql -F pr="$PR" -f after="$after" -f query="$query"); fi
  acc=$(jq -c --argjson p "$page" '. + ($p.data.repository.pullRequest.reviewThreads.nodes
        | map({id, isResolved, isOutdated, path, line,
               comments: (.comments.nodes | map({databaseId, author: .author.login, body, url, createdAt}))}))' <<<"$acc")
  [ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$page")" = true ] || break
  after=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$page")
done

total=$(jq 'length' <<<"$acc")
open=$(jq 'map(select(.isResolved | not)) | length' <<<"$acc")
[ "$ALL" = 1 ] || acc=$(jq -c 'map(select(.isResolved | not))' <<<"$acc")

if [ "$JSON" = 1 ]; then jq . <<<"$acc"; exit 0; fi

jq -r '.[] |
  "THREAD \(.id)  \(if .isResolved then "resolved" else "OPEN" end)\(if .isOutdated then " (outdated)" else "" end)  \(.path // "-")\(if .line then ":\(.line)" else "" end)",
  (.comments[] | "  #\(.databaseId) \(.author) \(.createdAt[0:10]): \(.body | gsub("\r"; "") | gsub("\n+"; " ⏎ ") | .[0:500])"),
  ""' <<<"$acc"
echo "PR #$PR: $total review threads, $open unresolved"
