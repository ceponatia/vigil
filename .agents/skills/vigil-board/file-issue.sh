#!/usr/bin/env bash
# Create and classify an issue, or resume a previously created issue.
#
#   file-issue.sh --title "…" (--body-file f | --body "…") [options]
#   file-issue.sh --issue N [classification/relation options]
#
# --issue N resumes after a partial failure without creating a duplicate.
# The issue number is always the last stdout line, including partial failures.
set -Eeuo pipefail

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
require_config VIGIL_BOARD_REPO

REPO="$VIGIL_BOARD_REPO"
TAXONOMY="bug technical-debt performance security documentation research evaluation initiative decision-needed agent-found"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
need_value() { [ "$#" -ge 2 ] || { echo "$1 requires a value" >&2; exit 64; }; }

TITLE=""; BODY=""; BODY_FILE=""; PARENT=""; ASSIGN=0; NUMBER=""
LABELS=(); BLOCKERS=(); FIELDS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --title) need_value "$@"; TITLE="$2"; shift 2 ;;
    --body) need_value "$@"; BODY="$2"; shift 2 ;;
    --body-file) need_value "$@"; BODY_FILE="$2"; shift 2 ;;
    --issue) need_value "$@"; NUMBER="$2"; shift 2 ;;
    --label) need_value "$@"; LABELS+=("$2"); shift 2 ;;
    --agent-found) LABELS+=(agent-found); shift ;;
    --parent) need_value "$@"; PARENT="$2"; shift 2 ;;
    --blocked-by) need_value "$@"; BLOCKERS+=("$2"); shift 2 ;;
    --status) need_value "$@"; FIELDS+=(Status "$2"); shift 2 ;;
    --horizon) need_value "$@"; FIELDS+=(Horizon "$2"); shift 2 ;;
    --phase) need_value "$@"; FIELDS+=(Phase "$2"); shift 2 ;;
    --priority) need_value "$@"; FIELDS+=(Priority "$2"); shift 2 ;;
    --area) need_value "$@"; FIELDS+=(Area "$2"); shift 2 ;;
    --assign) ASSIGN=1; shift ;;
    --help|-h) usage ;;
    *) echo "unknown argument $1" >&2; usage ;;
  esac
done

if [ -n "$NUMBER" ]; then
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || { echo "--issue must be an issue number" >&2; exit 64; }
else
  [ -n "$TITLE" ] || { echo "--title is required when creating" >&2; usage; }
  [ -n "$BODY" ] || [ -n "$BODY_FILE" ] || { echo "--body or --body-file is required when creating" >&2; usage; }
fi
if [ -n "$PARENT" ]; then [[ "$PARENT" =~ ^[0-9]+$ ]] || { echo "--parent must be an issue number" >&2; exit 64; }; fi
for n in "${BLOCKERS[@]}"; do
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "--blocked-by must be an issue number" >&2; exit 64; }
done
for label in "${LABELS[@]}"; do
  case " $TAXONOMY " in
    *" $label "*) ;;
    *) echo "label '$label' is not in the board's taxonomy ($TAXONOMY)" >&2; exit 1 ;;
  esac
done

report_failure() {
  local rc=$?
  if [ "$BASH_SUBSHELL" -gt 0 ]; then return "$rc"; fi
  trap - ERR
  if [ -n "$NUMBER" ]; then
    echo "file-issue stopped after issue #$NUMBER existed; resume with --issue $NUMBER and the same classification/relation options" >&2
    echo "$NUMBER"
  fi
  exit "$rc"
}
trap report_failure ERR

if [ -z "$NUMBER" ]; then
  args=(--repo "$REPO" --title "$TITLE")
  if [ -n "$BODY_FILE" ]; then args+=(--body-file "$BODY_FILE"); else args+=(--body "$BODY"); fi
  for label in "${LABELS[@]}"; do args+=(--label "$label"); done
  url=$(gh issue create "${args[@]}")
  NUMBER=${url##*/}
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || { echo "could not parse issue number from: $url" >&2; exit 1; }
  echo "created #$NUMBER  $url"
else
  url=$(gh api "repos/$REPO/issues/$NUMBER" --jq .html_url)
  echo "resuming #$NUMBER  $url"
  if [ ${#LABELS[@]} -gt 0 ]; then
    label_args=()
    for label in "${LABELS[@]}"; do label_args+=(--add-label "$label"); done
    gh issue edit "$NUMBER" --repo "$REPO" "${label_args[@]}" >/dev/null
  fi
fi

# Resolve relation ids and current relation state before board/relation writes.
child=""
parent_has_child=0
if [ -n "$PARENT" ]; then
  child=$(gh api "repos/$REPO/issues/$NUMBER" --jq .id)
  children=$(gh api --paginate --slurp "repos/$REPO/issues/$PARENT/sub_issues?per_page=100" | jq -c 'add // []')
  parent_has_child=$(jq --argjson id "$child" '[.[] | select(.id == $id)] | length' <<<"$children")
fi

declare -A BLOCKER_ID BLOCKER_PRESENT
if [ ${#BLOCKERS[@]} -gt 0 ]; then
  blocked=$(gh api --paginate --slurp "repos/$REPO/issues/$NUMBER/dependencies/blocked_by?per_page=100" | jq -c 'add // []')
  for blocker_number in "${BLOCKERS[@]}"; do
    BLOCKER_ID[$blocker_number]=$(gh api "repos/$REPO/issues/$blocker_number" --jq .id)
    BLOCKER_PRESENT[$blocker_number]=$(jq --argjson id "${BLOCKER_ID[$blocker_number]}" '[.[] | select(.id == $id)] | length' <<<"$blocked")
  done
fi

set_args=("$NUMBER")
[ "$ASSIGN" = 1 ] && set_args+=(--assign)
set_args+=("${FIELDS[@]}")
"$HERE/board-set.sh" "${set_args[@]}"

if [ -n "$PARENT" ]; then
  if [ "$parent_has_child" -gt 0 ]; then
    echo "  already a sub-issue of #$PARENT"
  else
    gh api -X POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$child" >/dev/null
    echo "  sub-issue of #$PARENT"
  fi
fi

for blocker_number in "${BLOCKERS[@]}"; do
  if [ "${BLOCKER_PRESENT[$blocker_number]}" -gt 0 ]; then
    echo "  already blocked by #$blocker_number"
  else
    gh api -X POST "repos/$REPO/issues/$NUMBER/dependencies/blocked_by" -F issue_id="${BLOCKER_ID[$blocker_number]}" >/dev/null
    echo "  blocked by #$blocker_number"
  fi
done

trap - ERR
echo "$NUMBER"
