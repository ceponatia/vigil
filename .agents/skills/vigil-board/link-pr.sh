#!/usr/bin/env bash
# Add a PR board item and exactly mirror its source issue's classification.
# Unset source fields explicitly clear stale PR values. Status is independent.
#
#   link-pr.sh <pr-number> <issue-number>
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=board.env
source "${VIGIL_BOARD_ENV:-$HERE/board.env}"

require_config() {
  local var="$1"
  local val="${!var:-}"
  case "$val" in
    ''|'TODO(bootstrap)'*) echo "not configured: set $var in ${VIGIL_BOARD_ENV:-$HERE/board.env}" >&2; exit 78 ;;
  esac
}
require_config VIGIL_BOARD_OWNER
require_config VIGIL_BOARD_REPO
require_config VIGIL_BOARD_PROJECT_ID

PR="${1:?usage: link-pr.sh <pr-number> <issue-number>}"
ISSUE="${2:?usage: link-pr.sh <pr-number> <issue-number>}"
[[ "$PR" =~ ^[0-9]+$ && "$ISSUE" =~ ^[0-9]+$ ]] || {
  echo "PR and issue must be numbers" >&2
  exit 64
}

OWNER="$VIGIL_BOARD_OWNER"
REPO_NAME="${VIGIL_BOARD_REPO#*/}"
PROJECT_ID="$VIGIL_BOARD_PROJECT_ID"
MIRROR=(Horizon Priority Area Phase)

lookup() {  # number kind -> "contentId itemId"
  gh api graphql -F n="$1" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"$REPO_NAME\") {
      $2(number:\$n) { id projectItems(first:20) { nodes { id project { id } } } } } }" \
    | jq -r --arg p "$PROJECT_ID" '.data.repository[] | select(. != null) | "\(.id) \([.projectItems.nodes[] | select(.project.id == $p) | .id][0] // "")"'
}

read -r _ issue_item <<<"$(lookup "$ISSUE" issue)"
[ -n "$issue_item" ] || { echo "issue #$ISSUE is not on the board — classify it first" >&2; exit 1; }
read -r pr_content pr_item <<<"$(lookup "$PR" pullRequest)"
[ -n "$pr_content" ] && [ "$pr_content" != null ] || { echo "PR #$PR does not exist" >&2; exit 1; }

# Resolve the complete desired state and every field id before adding or editing
# the PR item. This prevents a misspelled/missing field from leaving a partial
# mirror behind.
meta=$(gh api graphql -f source="$issue_item" -f project="$PROJECT_ID" -f query='
  query($source: ID!, $project: ID!) {
    source: node(id: $source) { ... on ProjectV2Item { fieldValues(first: 40) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        kind: __typename optionId name field { ... on ProjectV2SingleSelectField { id name } } }
    } } } }
    project: node(id: $project) { ... on ProjectV2 { fields(first: 40) { nodes {
      ... on ProjectV2SingleSelectField { kind: __typename id name }
    } } } }
  }')
src=$(jq -c '[.data.source.fieldValues.nodes[] | select(.field != null)]' <<<"$meta")
fields=$(jq -c '[.data.project.fields.nodes[] | select(.id != null and .name != null)]' <<<"$meta")

declare -A FIELD_ID MODE VALUE LABEL
for name in "${MIRROR[@]}"; do
  field=$(jq -c --arg n "$name" '[.[] | select(.name == $n)][0] // empty' <<<"$fields")
  [ -n "$field" ] || { echo "board field '$name' was not found; no PR changes made" >&2; exit 1; }
  FIELD_ID[$name]=$(jq -r .id <<<"$field")
  row=$(jq -c --arg n "$name" '[.[] | select(.field.name == $n)][0] // empty' <<<"$src")
  if [ -z "$row" ]; then
    MODE[$name]=clear
    VALUE[$name]=""
    LABEL[$name]="cleared (unset on #$ISSUE)"
  else
    MODE[$name]=single
    VALUE[$name]=$(jq -r .optionId <<<"$row")
    LABEL[$name]=$(jq -r .name <<<"$row")
  fi
  [ "${MODE[$name]}" = clear ] || [ -n "${VALUE[$name]}" ] || {
    echo "source value for $name has no id; no PR changes made" >&2
    exit 1
  }
done

if [ -z "$pr_item" ]; then
  pr_item=$(gh api graphql -f project="$PROJECT_ID" -f content="$pr_content" -f query='mutation($project:ID!, $content:ID!) {
      addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }' \
    --jq .data.addProjectV2ItemById.item.id)
  echo "added PR #$PR to the board ($pr_item)"
fi

for name in "${MIRROR[@]}"; do
  case "${MODE[$name]}" in
    clear)
      gh api graphql -f project="$PROJECT_ID" -f item="$pr_item" -f field="${FIELD_ID[$name]}" -f query='mutation($project:ID!, $item:ID!, $field:ID!) {
          clearProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field}) { projectV2Item { id } } }' >/dev/null
      ;;
    single)
      gh api graphql -f project="$PROJECT_ID" -f item="$pr_item" -f field="${FIELD_ID[$name]}" -f opt="${VALUE[$name]}" \
        -f query='mutation($project:ID!, $item:ID!, $field:ID!, $opt:String!) {
          updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{singleSelectOptionId:$opt}}) { projectV2Item { id } } }' >/dev/null
      ;;
  esac
  echo "  $name: ${LABEL[$name]}"
done

# Read back the target values. Mutation success only proves GitHub accepted a
# request; this verifies the board now has the intended values, including nulls.
actual=$(gh api graphql -f id="$pr_item" -f query='
  query($id: ID!) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: 40) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue {
      kind: __typename optionId field { ... on ProjectV2SingleSelectField { name } } }
  } } } } }' --jq '[.data.node.fieldValues.nodes[] | select(.field != null)]')

for name in "${MIRROR[@]}"; do
  row=$(jq -c --arg n "$name" '[.[] | select(.field.name == $n)][0] // empty' <<<"$actual")
  case "${MODE[$name]}" in
    clear) [ -z "$row" ] || { echo "verification failed: $name should be clear" >&2; exit 1; } ;;
    single) [ "$(jq -r .optionId <<<"$row")" = "${VALUE[$name]}" ] || { echo "verification failed: $name differs" >&2; exit 1; } ;;
  esac
done

echo "PR #$PR exactly mirrors #$ISSUE. Set the PR's Status independently."
