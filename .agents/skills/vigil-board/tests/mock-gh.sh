#!/usr/bin/env bash
set -u

scenario=${TEST_SCENARIO:?}
state_dir=${TEST_STATE_DIR:?}
printf '%s\n' "$*" >>"$state_dir/calls"

if [ "$1 $2" = "issue create" ]; then
  printf 'https://github.com/ceponatia/vigil-fixture/issues/99\n'
  exit 0
fi

if [ "$1 $2" = "issue edit" ]; then exit 0; fi

if [ "$scenario" = file-create-fail ] && [ "$1" = api ] && [ "${2:-}" = graphql ]; then
  echo 'simulated board classification failure' >&2
  exit 42
fi

if [ "$scenario" = file-resume ]; then
  if [ "$1" = api ] && [[ "$*" == *"repos/ceponatia/vigil-fixture/issues/99"* ]] && [[ " $* " == *" --jq .html_url "* ]]; then
    printf 'https://github.com/ceponatia/vigil-fixture/issues/99\n'; exit 0
  fi
  if [ "$1" = api ] && [[ "$*" == *"repos/ceponatia/vigil-fixture/issues/99"* ]] && [[ " $* " == *" --jq .id "* ]]; then
    printf '999\n'; exit 0
  fi
  if [ "$1" = api ] && [[ "$*" == *"issues/10/sub_issues?per_page=100"* ]]; then
    printf '[[{"id":999,"number":99}]]\n'; exit 0
  fi
  if [ "$1" = api ] && [[ "$*" == *"issues/99/dependencies/blocked_by?per_page=100"* ]]; then
    printf '[[{"id":2020,"number":20}]]\n'; exit 0
  fi
  if [ "$1" = api ] && [[ "$*" == *"repos/ceponatia/vigil-fixture/issues/20"* ]] && [[ " $* " == *" --jq .id "* ]]; then
    printf '2020\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"n=99"* ]] && [[ "$*" == *"projectItems"* ]]; then
    printf '{"data":{"repository":{"issue":{"id":"ISSUE_NODE","projectItems":{"nodes":[{"id":"ISSUE_ITEM","project":{"id":"TESTPROJID1234"}}]}}}}}\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"fields(first:40)"* ]]; then
    printf '[{"id":"F_STATUS","name":"Status","dataType":"SINGLE_SELECT","options":[{"id":"O_TODO","name":"Todo"}]}]\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ]; then printf '{}\n'; exit 0; fi
  if [ "$1" = api ] && [ "${2:-}" = -X ]; then printf '{}\n'; exit 0; fi
fi

if [ "$scenario" = link-clear ]; then
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"n=10"* ]] && [[ "$*" == *"issue(number"* ]]; then
    printf '{"data":{"repository":{"issue":{"id":"ISSUE_NODE","projectItems":{"nodes":[{"id":"ISSUE_ITEM","project":{"id":"TESTPROJID1234"}}]}}}}}\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"n=11"* ]] && [[ "$*" == *"pullRequest(number"* ]]; then
    printf '{"data":{"repository":{"pullRequest":{"id":"PR_NODE","projectItems":{"nodes":[{"id":"PR_ITEM","project":{"id":"TESTPROJID1234"}}]}}}}}\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"source=ISSUE_ITEM"* ]]; then
    printf '%s\n' '{"data":{"source":{"fieldValues":{"nodes":[{"kind":"ProjectV2ItemFieldSingleSelectValue","optionId":"O_NOW","name":"Now","field":{"id":"F_HORIZON","name":"Horizon"}}]}},"project":{"fields":{"nodes":[{"kind":"ProjectV2SingleSelectField","id":"F_HORIZON","name":"Horizon"},{"kind":"ProjectV2SingleSelectField","id":"F_PRIORITY","name":"Priority"},{"kind":"ProjectV2SingleSelectField","id":"F_AREA","name":"Area"},{"kind":"ProjectV2SingleSelectField","id":"F_PHASE","name":"Phase"}]}}}}'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ] && [[ "$*" == *"id=PR_ITEM"* ]] && [[ "$*" == *"fieldValues"* ]]; then
    printf '[{"kind":"ProjectV2ItemFieldSingleSelectValue","optionId":"O_NOW","field":{"name":"Horizon"}}]\n'; exit 0
  fi
  if [ "$1" = api ] && [ "${2:-}" = graphql ]; then printf '{}\n'; exit 0; fi
fi

echo "unexpected mock gh call: $*" >&2
exit 97
