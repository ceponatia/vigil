#!/usr/bin/env bash
# Close the loop on one review thread: reply saying what changed and where
# (name the commit), then mark the thread resolved — the two halves the root
# repository instructions require together. Works on merged PRs too.
#
#   reply-resolve.sh <pr> <thread-id | comment-id> --body "…" | --body-file f
#   reply-resolve.sh <pr> <thread-id | comment-id> --body "…" --no-resolve
#   reply-resolve.sh <pr> <thread-id> --resolve-only
#
# <thread-id> is the PRRT_… id from threads.sh; a numeric review-comment id
# also works. --no-resolve replies and leaves the thread open (you disagree;
# the owner decides). --resolve-only resolves a thread that already carries
# your reply. Never resolve a thread you did not address.
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

PR="${1:?usage: reply-resolve.sh <pr> <thread-id|comment-id> (--body … | --body-file f) [--no-resolve|--resolve-only]}"
TARGET="${2:?thread id or comment id required}"; shift 2
BODY=""; RESOLVE=1; REPLY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --body) BODY="$2"; shift 2 ;;
    --body-file) BODY=$(cat "$2"); shift 2 ;;
    --no-resolve) RESOLVE=0; shift ;;
    --resolve-only) REPLY=0; shift ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done
[ "$REPLY" = 0 ] || [ -n "$BODY" ] || { echo "--body or --body-file is required (say what changed and name the commit)" >&2; exit 1; }

# --- locate the thread and its first comment ----------------------------------------
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  thread=$("$HERE/threads.sh" "$PR" --all --json \
    | jq -c --argjson c "$TARGET" '[.[] | select(any(.comments[]; .databaseId == $c))][0] // empty')
  [ -n "$thread" ] || { echo "no review thread on #$PR contains comment $TARGET" >&2; exit 1; }
else
  thread=$(gh api graphql -f id="$TARGET" -f query='query($id:ID!) { node(id:$id) { ... on PullRequestReviewThread {
      id isResolved comments(first:1) { nodes { databaseId } } } } }' \
    | jq -c '.data.node | select(.id != null) | {id, isResolved, comments: .comments.nodes}')
  [ -n "$thread" ] || { echo "$TARGET is not a review thread id" >&2; exit 1; }
fi
thread_id=$(jq -r .id <<<"$thread")
first_comment=$(jq -r '.comments[0].databaseId' <<<"$thread")

# --- reply ----------------------------------------------------------------------------
if [ "$REPLY" = 1 ]; then
  url=$(gh api -X POST "repos/$REPO/pulls/$PR/comments/$first_comment/replies" -f body="$BODY" --jq .html_url)
  echo "replied: $url"
fi

# --- resolve ---------------------------------------------------------------------------
if [ "$RESOLVE" = 1 ]; then
  state=$(gh api graphql -f id="$thread_id" -f query='mutation($id:ID!) {
      resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }' \
    --jq '.data.resolveReviewThread.thread.isResolved')
  echo "thread $thread_id resolved: $state"
else
  echo "thread $thread_id left open"
fi
