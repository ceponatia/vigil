#!/usr/bin/env bash
set -u

scenario=${TEST_SCENARIO:?}
state_dir=${TEST_STATE_DIR:?}
head_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
head_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
reviewer='vigil-review-bot[bot]'
printf '%s\n' "$*" >>"$state_dir/calls"

# Run and job identities taken from PR #14 at head 72338c5, the sequence the
# wait-* scenarios below replay: a draft-triggered run whose jobs the workflow's
# draft guard skipped, then the ready_for_review-triggered run seven seconds
# later. `run_older` is a second draft-guarded run for the all-skipped case.
run_older=34719255100
run_draft=34719260700
run_ready=34719267014
link_older="https://github.com/ceponatia/vigil/actions/runs/$run_older/job/103621900001"
link_draft="https://github.com/ceponatia/vigil/actions/runs/$run_draft/job/103621979362"
link_ready="https://github.com/ceponatia/vigil/actions/runs/$run_ready/job/103622095513"
at_older=2026-09-12T21:11:00Z
at_draft=2026-09-12T21:11:59Z
at_ready=2026-09-12T21:12:06Z

next_count() {
  local name=$1 file="$state_dir/$1"
  local count=0
  [ ! -f "$file" ] || read -r count <"$file"
  count=$((count + 1))
  printf '%s\n' "$count" >"$file"
  printf '%s\n' "$count"
}

pr_json() {
  local head=$1
  printf '{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"%s","url":"https://example.test/pr/1","title":"fixture","reviewRequests":[],"assignees":[]}\n' "$head"
}

# One `gh pr checks --required --json …` entry. The rollup holds exactly one
# entry per check NAME and replaces it in place, so no scenario here emits two
# `CI/verify` entries: that state does not occur. `link` is the check run's own
# job URL, which is what names the run the entry came from.
check_json() { # name workflow bucket state link
  printf '{"name":"%s","workflow":"%s","bucket":"%s","state":"%s","event":"pull_request","link":"%s"}' "$1" "$2" "$3" "$4" "$5"
}

# One `gh run list --json …` entry. gh types `conclusion` as a string, so a run
# that has not finished carries "" rather than null.
run_json() { # databaseId status conclusion createdAt
  printf '{"databaseId":%s,"status":"%s","conclusion":"%s","createdAt":"%s","workflowName":"CI","event":"pull_request","headSha":"%s"}' "$1" "$2" "$3" "$4" "$run_head"
}

json_array() { local IFS=,; printf '[%s]\n' "$*"; }

if [ "$1 $2" = "pr view" ]; then
  if [[ " $* " == *" --jq .headRefOid "* ]]; then
    printf '%s\n' "$head_a"
  elif [ "$scenario" = wait-stale ]; then
    count=$(next_count views)
    if [ "$count" -eq 1 ]; then pr_json "$head_a"; else pr_json "$head_b"; fi
  else
    pr_json "$head_a"
  fi
  exit 0
fi

if [ "$1 $2" = "pr checks" ]; then
  case "$scenario" in
    wait-pending)
      count=$(next_count checks)
      if [ "$count" -eq 1 ]; then
        json_array "$(check_json verify CI pending IN_PROGRESS "$link_ready")"
        exit 8
      fi
      json_array "$(check_json verify CI pass SUCCESS "$link_ready")"
      ;;
    wait-draft-then-ready)
      # The observed live sequence at PR #14's head, poll by poll. The rollup's
      # single CI/verify is the draft run's SKIPPED one while the ready run is
      # in progress (poll 1); GitHub then clears it (poll 2) before the ready
      # run's own verify job registers (poll 3) and finishes (poll 4). Only the
      # run list separates poll 1 from a genuine lone skip.
      count=$(next_count checks)
      case "$count" in
        1) json_array "$(check_json verify CI skipping SKIPPED "$link_draft")" ;;
        2) echo 'no checks reported on the branch' >&2; exit 1 ;;
        3) json_array "$(check_json verify CI pending IN_PROGRESS "$link_ready")"; exit 8 ;;
        *) json_array "$(check_json verify CI pass SUCCESS "$link_ready")" ;;
      esac
      ;;
    wait-skipped-only)
      # A draft-guarded run's skipped verify that is itself the newest CI run
      # for this head: nothing supersedes it.
      json_array "$(check_json verify CI skipping SKIPPED "$link_draft")"
      ;;
    wait-verify-all-skipped)
      # Two draft-guarded runs for the same head and no newer one. The rollup
      # carries the newest run's skipped verify — the older run's entry was
      # replaced, not kept beside it.
      json_array "$(check_json verify CI skipping SKIPPED "$link_draft")"
      ;;
    wait-peer-skipped)
      # The superseded shape (the rollup's CI/verify is the draft run's skip
      # while the ready run is in progress) beside another workflow's own
      # skipped required check, which no CI run supersedes.
      json_array "$(check_json verify CI skipping SKIPPED "$link_draft")" \
                 "$(check_json security Security skipping SKIPPED https://example.test/run/2)"
      ;;
    wait-draft-cancelled-then-ready)
      # The workflow's own concurrency: cancel-in-progress cancels the draft run
      # when the ready run is created while it is still queued, so the rollup's
      # CI/verify is CANCELLED — superseded exactly as a skip is — until the
      # ready run replaces it.
      count=$(next_count checks)
      if [ "$count" -eq 1 ]; then
        json_array "$(check_json verify CI cancel CANCELLED "$link_draft")"
      else
        json_array "$(check_json verify CI pass SUCCESS "$link_ready")"
      fi
      ;;
    wait-failing|wait-stale)
      if [ "$scenario" = wait-stale ] && [ "$(next_count checks)" -eq 1 ]; then
        json_array "$(check_json verify CI pass SUCCESS "$link_ready")"
        exit 0
      fi
      json_array "$(check_json verify CI fail FAILURE "$link_ready")"
      exit 1
      ;;
    wait-unrelated)
      json_array "$(check_json 'documentation checks' CI pass SUCCESS "$link_ready")"
      ;;
    wait-required-peer-fail)
      json_array "$(check_json verify CI pass SUCCESS "$link_ready")" \
                 "$(check_json security Security fail FAILURE https://example.test/run/2)"
      exit 1
      ;;
    wait-no-checks)
      # The real wording behind `gh pr checks --required`: it differs from the
      # bare form (still exercised by wait-draft-then-ready's transitional poll
      # above) by inserting "required".
      echo "no required checks reported on the 'fixture' branch" >&2
      exit 1
      ;;
    *)
      printf '[{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS"}]\n'
      ;;
  esac
  exit 0
fi

if [ "$1 $2" = "run list" ]; then
  run_head=$head_a
  prev=""
  for arg in "$@"; do
    [ "$prev" != --commit ] || run_head=$arg
    prev=$arg
  done
  case "$scenario" in
    wait-pending)
      if [ "$(next_count runs)" -eq 1 ]; then
        json_array "$(run_json "$run_ready" in_progress '' "$at_ready")"
      else
        json_array "$(run_json "$run_ready" completed success "$at_ready")"
      fi
      ;;
    wait-draft-then-ready)
      if [ "$(next_count runs)" -le 3 ]; then
        json_array "$(run_json "$run_draft" completed skipped "$at_draft")" \
                   "$(run_json "$run_ready" in_progress '' "$at_ready")"
      else
        json_array "$(run_json "$run_draft" completed skipped "$at_draft")" \
                   "$(run_json "$run_ready" completed success "$at_ready")"
      fi
      ;;
    wait-skipped-only)
      json_array "$(run_json "$run_draft" completed skipped "$at_draft")"
      ;;
    wait-verify-all-skipped)
      json_array "$(run_json "$run_older" completed skipped "$at_older")" \
                 "$(run_json "$run_draft" completed skipped "$at_draft")"
      ;;
    wait-peer-skipped|wait-draft-cancelled-then-ready)
      if [ "$(next_count runs)" -eq 1 ]; then
        json_array "$(run_json "$run_draft" completed cancelled "$at_draft")" \
                   "$(run_json "$run_ready" in_progress '' "$at_ready")"
      else
        json_array "$(run_json "$run_draft" completed cancelled "$at_draft")" \
                   "$(run_json "$run_ready" completed success "$at_ready")"
      fi
      ;;
    wait-failing)
      json_array "$(run_json "$run_ready" completed failure "$at_ready")"
      ;;
    wait-stale)
      if [ "$(next_count runs)" -eq 1 ]; then
        json_array "$(run_json "$run_ready" completed success "$at_ready")"
      else
        json_array "$(run_json "$run_ready" completed failure "$at_ready")"
      fi
      ;;
    wait-unrelated|wait-required-peer-fail)
      json_array "$(run_json "$run_ready" completed success "$at_ready")"
      ;;
    *)
      printf '[]\n'
      ;;
  esac
  exit 0
fi

if [ "$1" = api ] && [[ " $* " == *" graphql "* ]]; then
  if [ "$scenario" = review-old-open-clean ]; then
    printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"PRRT_old","isResolved":false,"isOutdated":true,"path":"old.ts","line":1,"comments":{"nodes":[{"databaseId":5,"author":{"login":"%s"},"body":"old finding","url":"https://example.test/thread","createdAt":"2025-12-31T00:00:00Z"}]}}]}}}}}\n' "$reviewer"
    exit 0
  fi
  printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n'
  exit 0
fi

if [ "$1" = api ] && [[ "$*" == *"pulls/1/reviews?per_page=100"* ]]; then
  case "$scenario" in
    review-findings)
      printf '[[{"user":{"login":"%s"},"state":"COMMENTED","submitted_at":"2026-01-01T00:02:00Z","commit_id":"%s","body":"finding"}]]\n' "$reviewer" "$head_a"
      ;;
    review-stale)
      printf '[[{"user":{"login":"%s"},"state":"COMMENTED","submitted_at":"2026-01-01T00:02:00Z","commit_id":"%s","body":"finding"}]]\n' "$reviewer" "$head_b"
      ;;
    review-approved)
      printf '[[{"user":{"login":"%s"},"state":"COMMENTED","submitted_at":"2026-01-01T00:01:00Z","commit_id":"%s","body":"old finding"},{"user":{"login":"%s"},"state":"APPROVED","submitted_at":"2026-01-01T00:02:00Z","commit_id":"%s","body":"approved"}]]\n' "$reviewer" "$head_a" "$reviewer" "$head_a"
      ;;
    review-dismissed)
      printf '[[{"user":{"login":"%s"},"state":"DISMISSED","submitted_at":"2026-01-01T00:02:00Z","commit_id":"%s","body":"dismissed"}]]\n' "$reviewer" "$head_a"
      ;;
    *) printf '[[]]\n' ;;
  esac
  exit 0
fi

if [ "$1" = api ] && [[ "$*" == *"issues/1/comments?per_page=100"* ]]; then
  trigger=$(printf '{"id":42,"user":{"login":"ceponatia"},"created_at":"2026-01-01T00:01:00Z","body":"@%s review\\nHead: %s"}' "$reviewer" "$head_a")
  legacy=$(printf '{"id":42,"user":{"login":"ceponatia"},"created_at":"2026-01-01T00:01:00Z","body":"@%s review"}' "$reviewer")
  bot_current=$(printf '{"id":43,"user":{"login":"%s"},"created_at":"2026-01-01T00:02:00Z","body":"Review status for `%s`"}' "$reviewer" "${head_a:0:10}")
  clean=$(printf '{"id":44,"user":{"login":"%s"},"created_at":"2026-01-01T00:02:00Z","body":"Review: Did not find any major issues. Reviewed commit: `%s`"}' "$reviewer" "${head_a:0:10}")
  case "$scenario" in
    review-clean|review-old-open-clean) printf '[[%s,%s]]\n' "$trigger" "$clean" ;;
    review-impostor|review-trusted-reaction) printf '[[%s,%s]]\n' "$trigger" "$bot_current" ;;
    review-pending) printf '[[%s]]\n' "$trigger" ;;
    review-legacy) printf '[[%s]]\n' "$legacy" ;;
    *) printf '[[]]\n' ;;
  esac
  exit 0
fi

if [ "$1" = api ] && [[ "$*" == *"commits/${head_a:0:10}"* ]] && [[ " $* " == *" --jq .sha "* ]]; then
  printf '%s\n' "$head_a"
  exit 0
fi

if [ "$1" = api ] && [[ "$*" == *"commits/$head_a"* ]]; then
  if [[ " $* " == *" --jq .sha "* ]]; then printf '%s\n' "$head_a"; else printf '2026-01-01T00:00:00Z\n'; fi
  exit 0
fi

if [ "$1" = api ] && [[ "$*" == *"issues/comments/42/reactions?per_page=100"* ]]; then
  case "$scenario" in
    review-impostor) printf '[[{"user":{"login":"someone-else"},"content":"+1"}]]\n' ;;
    review-trusted-reaction) printf '[[{"user":{"login":"%s"},"content":"+1"}]]\n' "$reviewer" ;;
    *) printf '[[]]\n' ;;
  esac
  exit 0
fi

echo "unexpected mock gh call: $*" >&2
exit 97
