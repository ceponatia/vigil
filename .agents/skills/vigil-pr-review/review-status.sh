#!/usr/bin/env bash
# Report CI, threads, and a head- and identity-verified reviewer state.
#
#   review-status.sh <pr>
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
# The reviewer login is optional here: an unset value degrades only the final
# classification line to "unverified", it does not stop this helper's other,
# identity-independent checks (CI, threads, raw review/comment listing).
REVIEWER=""
case "${VIGIL_REVIEWER_LOGIN:-}" in
  ''|'TODO(bootstrap)'*) REVIEWER="" ;;
  *) REVIEWER="$VIGIL_REVIEWER_LOGIN" ;;
esac

PR="${1:?usage: review-status.sh <pr>}"

v=$(gh pr view "$PR" --repo "$REPO" --json state,isDraft,mergeable,mergeStateStatus,headRefOid,url,title,reviewRequests,assignees)
head=$(jq -r .headRefOid <<<"$v")
[[ "$head" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "invalid PR head SHA: $head" >&2; exit 5; }

echo "PR #$PR  $(jq -r .title <<<"$v")"
echo "  $(jq -r .url <<<"$v")"
echo "  state=$(jq -r .state <<<"$v") draft=$(jq -r .isDraft <<<"$v") mergeable=$(jq -r .mergeable <<<"$v")/$(jq -r .mergeStateStatus <<<"$v") head=$head assignees=$(jq -r '[.assignees[].login] | join(",")' <<<"$v")"

echo "CI:"
set +e
checks=$(gh pr checks "$PR" --repo "$REPO" --required --json name,bucket,state,workflow 2>&1)
checks_rc=$?
set -e
if { [ "$checks_rc" -eq 0 ] || [ "$checks_rc" -eq 1 ] || [ "$checks_rc" -eq 8 ]; } \
  && jq -e 'type == "array" and length > 0' <<<"$checks" >/dev/null 2>&1; then
  jq -r '.[] | "  \(.bucket): \(.workflow)/\(.name) (\(.state))"' <<<"$checks"
else
  echo "  unavailable (rc=$checks_rc): $(tr '\n' ' ' <<<"$checks")"
fi

threads=$("$HERE/threads.sh" "$PR" --all --json)
echo "threads: $(jq 'length' <<<"$threads") total, $(jq 'map(select(.isResolved | not)) | length' <<<"$threads") unresolved"

# REST is used here because review rows expose commit_id. --paginate --slurp
# keeps status correct once a PR exceeds GitHub's first 100 comments/reviews.
reviews=$(gh api --paginate --slurp "repos/$REPO/pulls/$PR/reviews?per_page=100" | jq -c 'add // []')
comments=$(gh api --paginate --slurp "repos/$REPO/issues/$PR/comments?per_page=100" | jq -c 'add // []')
head_date=$(gh api "repos/$REPO/commits/$head" --jq .commit.committer.date)

echo "reviews:"
if [ "$(jq 'length' <<<"$reviews")" -eq 0 ]; then
  echo "  none"
else
  jq -r '.[] | "  \(.submitted_at[0:16]) \(.user.login) \(.state) commit=\(.commit_id[0:8])"' <<<"$reviews"
fi
echo "review requests: $(jq -r '[.reviewRequests[] | (.login // .name // "?")] | join(", ") | if . == "" then "none" else . end' <<<"$v")"

if [ -z "$REVIEWER" ]; then
  echo "review: unverified — reviewer not configured (set VIGIL_REVIEWER_LOGIN in ${VIGIL_REVIEW_ENV:-$HERE/review.env})"
  exit 0
fi

current_reviews=$(jq -c --arg who "$REVIEWER" --arg head "$head" \
  '[.[] | select(.user.login == $who and .commit_id == $head)]' <<<"$reviews")
latest_current_state=$(jq -r 'sort_by(.submitted_at) | last | .state // empty' <<<"$current_reviews")
trusted_open_threads=$(jq --arg who "$REVIEWER" \
  '[.[] | select(.isResolved | not) | select(any(.comments[]; .author == $who))] | length' <<<"$threads")
requested_reviewer=$(jq --arg who "$REVIEWER" \
  '[.reviewRequests[] | select((.login // .name // "") == $who)] | length' <<<"$v")

# New requests carry the full head in their body. Legacy plain triggers have no
# immutable commit identity and remain unverified even when their timing looks
# current. Matching is a plain case-insensitive substring rather than a regex
# so a reviewer login containing regex metacharacters (a bot login such as
# "name[bot]" is common) cannot be misparsed as a character class.
is_trigger() {  # body
  local body_lower mention1 mention2
  body_lower=$(tr '[:upper:]' '[:lower:]' <<<"$1")
  mention1=$(tr '[:upper:]' '[:lower:]' <<<"@$REVIEWER review")
  mention2=$(tr '[:upper:]' '[:lower:]' <<<"@$REVIEWER security review")
  [[ "$body_lower" == *"$mention1"* || "$body_lower" == *"$mention2"* ]]
}
trigger=""
legacy_trigger=""
while IFS= read -r comment; do
  [ -n "$comment" ] || continue
  body=$(jq -r .body <<<"$comment")
  author=$(jq -r .user.login <<<"$comment")
  [ "$author" != "$REVIEWER" ] || continue
  is_trigger "$body" || continue
  created_at=$(jq -r .created_at <<<"$comment")
  if jq -e --arg head "$head" '.body | contains($head)' <<<"$comment" >/dev/null; then
    trigger=$comment
  elif [[ "$created_at" > "$head_date" || "$created_at" == "$head_date" ]]; then
    legacy_trigger=$comment
  fi
done < <(jq -c '.[]' <<<"$comments")

# Clean comments currently cite an abbreviated reviewed commit. Resolve that
# ref through GitHub before comparing it with the full current head.
clean_ref=$(jq -r --arg who "$REVIEWER" \
  '[.[] | select(.user.login == $who and (.body | test("did(n.t| not) find any major issues|no (major )?issues"; "i"))) | (try (.body | match("Reviewed commit:[^`]*`([0-9a-fA-F]{7,40})`"; "i").captures[0].string) catch empty)] | last // empty' <<<"$comments")
clean_verified=0
clean_unverified=0
if [ -n "$clean_ref" ]; then
  set +e
  resolved_clean=$(gh api "repos/$REPO/commits/$clean_ref" --jq .sha 2>/dev/null)
  resolve_rc=$?
  set -e
  if [ "$resolve_rc" -eq 0 ] && [ "$resolved_clean" = "$head" ]; then
    clean_verified=1
  else
    clean_unverified=1
  fi
fi

trusted_plus=0
untrusted_plus=0
if [ -n "$trigger" ]; then
  trigger_id=$(jq -r .id <<<"$trigger")
  reactions=$(gh api --paginate --slurp -H 'Accept: application/vnd.github+json' \
    "repos/$REPO/issues/comments/$trigger_id/reactions?per_page=100" | jq -c 'add // []')
  trusted_plus=$(jq --arg who "$REVIEWER" '[.[] | select(.content == "+1" and .user.login == $who)] | length' <<<"$reactions")
  untrusted_plus=$(jq --arg who "$REVIEWER" '[.[] | select(.content == "+1" and .user.login != $who)] | length' <<<"$reactions")
fi

# Re-read the full head after all paginated queries. A push during inspection
# invalidates every result above, even if its first seven characters look alike.
final_head=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
if [ "$final_head" != "$head" ]; then
  echo "review: unverified — head changed during inspection ($head -> $final_head); run again"
  exit 0
fi

stale_signal=$(jq --arg who "$REVIEWER" --arg head "$head" \
  '[.[] | select(.user.login == $who and .commit_id != $head)] | length' <<<"$reviews")
current_request=0
[ -n "$trigger" ] && current_request=1
[ "$requested_reviewer" -gt 0 ] && current_request=1

if [ "$trusted_open_threads" -gt 0 ]; then
  echo "review: findings — $trusted_open_threads unresolved thread(s) from $REVIEWER, including older-head threads"
elif [ "$latest_current_state" = COMMENTED ] || [ "$latest_current_state" = CHANGES_REQUESTED ]; then
  echo "review: findings — latest $REVIEWER review on current head $head is $latest_current_state; no unresolved trusted threads"
elif [ "$latest_current_state" = APPROVED ] || [ "$clean_verified" -eq 1 ] || [ "$trusted_plus" -gt 0 ]; then
  echo "review: clean — verified response by $REVIEWER for current head $head"
elif [ "$untrusted_plus" -gt 0 ]; then
  echo "review: unverified — a reaction exists on the trigger comment, but not from $REVIEWER"
elif [ "$current_request" -eq 1 ]; then
  echo "review: pending — review requested for current head $head, no verified response yet"
elif [ -n "$legacy_trigger" ] || [ "$clean_unverified" -eq 1 ] || [ "$latest_current_state" = DISMISSED ] || [ "$stale_signal" -gt 0 ]; then
  echo "review: unverified — reviewer signal is legacy, dismissed, ambiguous, or belongs to an older head"
else
  echo "review: unrequested — no review request or verified response for current head $head"
fi
