#!/usr/bin/env bash
# Offline stand-in for `gh` used by test_board_audit.py. Records every call and
# answers GraphQL reads from canned files; anything else is an unexpected call.
set -u
state_dir=${TEST_STATE_DIR:?}
printf '%s\n' "$*" >>"$state_dir/calls"

if [ "${1:-}" = api ] && [ "${2:-}" = graphql ]; then
  case "$*" in
    *"fields(first:"*) cat "${FAKE_GH_FIELDS:?}"; exit 0 ;;
    *"issue(number:"*)     cat "${FAKE_GH_BATCH:?}"; exit 0 ;;
  esac
fi
if [ "${1:-}" = issue ] && [ "${2:-}" = list ]; then
  printf '[{"number":4},{"number":3}]\n'; exit 0
fi
echo "unexpected fake gh call: $*" >&2
exit 97
