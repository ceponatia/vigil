#!/usr/bin/env bash
# Set board fields on an issue or PR by NAME — the item-id, field-id and
# option-id lookups are done for you — and apply the assignment convention.
#
#   board-set.sh <number> [--pr] [--assign|--unassign] [--dry-run] [<Field> <Value>]...
#
#   board-set.sh 254 Status "In progress" --assign
#   board-set.sh 258 --pr Status "In review"
#   board-set.sh 259 Horizon Next Priority High Area Data Phase "Bootstrap & Paper"
#   board-set.sh 259                                   # just make sure it is on the board
#
# Single-select fields (Status, Horizon, Phase, Area, Priority, Size, Owning
# role) take an option name, case-insensitive; the option list is queried live,
# never hardcoded. Text fields (Evidence) take the text verbatim.
# --assign / --unassign edit the issue or PR itself (assignee from board.env):
# the board's "the next action is the owner's" signal.
#
# The board holds two separate rows for an issue and its PR, so a number is
# looked up as an Issue unless --pr is given. An issue missing from the board is
# added; a PR missing from the board is an error — use link-pr.sh, which also
# mirrors the issue's classification onto the PR row.
#
# Everything goes through `gh api graphql` (small queries, explicit mutations)
# and REST — never `gh project …`, whose calls are large and can be refused
# with "API rate limit exceeded" while direct GraphQL still works.
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
require_config VIGIL_BOARD_ASSIGNEE

REPO="$VIGIL_BOARD_REPO"
OWNER="$VIGIL_BOARD_OWNER"
REPO_NAME="${REPO#*/}"
PROJECT_ID="$VIGIL_BOARD_PROJECT_ID"
ASSIGNEE="$VIGIL_BOARD_ASSIGNEE"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

[ $# -ge 1 ] || usage
NUMBER="$1"; shift
[[ "$NUMBER" =~ ^[0-9]+$ ]] || usage

TYPE=Issue; ASSIGN=""; DRY=0; PAIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) TYPE=PullRequest; shift ;;
    --assign) ASSIGN=add; shift ;;
    --unassign) ASSIGN=remove; shift ;;
    --dry-run) DRY=1; shift ;;
    --help|-h) usage ;;
    --*) echo "unknown flag $1" >&2; usage ;;
    *) [ $# -ge 2 ] || { echo "field '$1' has no value" >&2; usage; }
       PAIRS+=("$1" "$2"); shift 2 ;;
  esac
done

run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

# --- item id (one small query; adds the issue to the board if absent) ---------------
kind=issue; [ "$TYPE" = PullRequest ] && kind=pullRequest
content=$(gh api graphql -F n="$NUMBER" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"$REPO_NAME\") {
    $kind(number:\$n) { id projectItems(first:20) { nodes { id project { id } } } } } }")
content_id=$(jq -r '.data.repository[] | .id' <<<"$content")
item_id=$(jq -r --arg p "$PROJECT_ID" '[.data.repository[] | .projectItems.nodes[] | select(.project.id == $p) | .id][0] // empty' <<<"$content")
if [ -z "$item_id" ]; then
  if [ "$TYPE" = Issue ]; then
    if [ "$DRY" = 1 ]; then
      echo "  (dry-run) would add issue #$NUMBER to the board"; item_id=DRY
    else
      item_id=$(gh api graphql -f project="$PROJECT_ID" -f content="$content_id" -f query='mutation($project:ID!, $content:ID!) {
          addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }' \
        --jq .data.addProjectV2ItemById.item.id)
      echo "added issue #$NUMBER to the board ($item_id)"
    fi
  else
    echo "PR #$NUMBER is not on the board — run link-pr.sh <pr> <issue> first" >&2
    exit 1
  fi
else
  echo "#$NUMBER ($TYPE) is board item $item_id"
fi

# --- fields ----------------------------------------------------------------------------
if [ ${#PAIRS[@]} -gt 0 ]; then
  fields=$(gh api graphql -f project="$PROJECT_ID" -f query='query($project:ID!) { node(id:$project) { ... on ProjectV2 {
      fields(first:40) { nodes {
        ... on ProjectV2Field { id name dataType }
        ... on ProjectV2SingleSelectField { id name dataType options { id name } }
      } } } } }' --jq '.data.node.fields.nodes')

  set_single() {  # item field option
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f opt="$3" -f query='mutation($project:ID!, $item:ID!, $field:ID!, $opt:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{singleSelectOptionId:$opt}}) { projectV2Item { id } } }' >/dev/null
  }
  set_text() {  # item field text
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f text="$3" -f query='mutation($project:ID!, $item:ID!, $field:ID!, $text:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{text:$text}}) { projectV2Item { id } } }' >/dev/null
  }
  clear_field() {  # item field
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f query='mutation($project:ID!, $item:ID!, $field:ID!) {
        clearProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field}) { projectV2Item { id } } }' >/dev/null
  }

  set_pair() {
    local name="$1" value="$2" field field_id dtype
    field=$(jq -c --arg n "$name" '[.[] | select((.name | ascii_downcase) == ($n | ascii_downcase))][0] // empty' <<<"$fields")
    [ -n "$field" ] || { echo "no board field named '$name'" >&2; exit 1; }
    field_id=$(jq -r .id <<<"$field"); dtype=$(jq -r .dataType <<<"$field")

    if [ "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" = none ]; then
      clear_field "$item_id" "$field_id"; echo "  $name: cleared"; return
    fi
    case "$dtype" in
      SINGLE_SELECT)
        local opt
        opt=$(jq -r --arg v "$value" '[.options[] | select((.name | ascii_downcase) == ($v | ascii_downcase))][0].id // empty' <<<"$field")
        [ -n "$opt" ] || { echo "$name has no option '$value' (options: $(jq -r '[.options[].name] | join(", ")' <<<"$field"))" >&2; exit 1; }
        set_single "$item_id" "$field_id" "$opt"
        echo "  $name: $(jq -r --arg id "$opt" '.options[] | select(.id == $id) | .name' <<<"$field")" ;;
      TEXT)
        set_text "$item_id" "$field_id" "$value"
        echo "  $name: $value" ;;
      *) echo "$name is $dtype; this script sets single-select and text fields only" >&2; exit 1 ;;
    esac
  }

  i=0
  while [ $i -lt ${#PAIRS[@]} ]; do
    set_pair "${PAIRS[$i]}" "${PAIRS[$((i+1))]}"
    i=$((i+2))
  done
fi

# --- assignment (REST; PRs are issues here) ---------------------------------------------
if [ -n "$ASSIGN" ]; then
  if [ "$ASSIGN" = add ]; then
    run gh api -X POST "repos/$REPO/issues/$NUMBER/assignees" -f "assignees[]=$ASSIGNEE" >/dev/null
    echo "  assigned $ASSIGNEE (next action is the owner's)"
  else
    run gh api -X DELETE "repos/$REPO/issues/$NUMBER/assignees" -f "assignees[]=$ASSIGNEE" >/dev/null
    echo "  unassigned $ASSIGNEE (back in the pool)"
  fi
fi
