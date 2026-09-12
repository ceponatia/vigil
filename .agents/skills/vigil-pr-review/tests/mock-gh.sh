#!/usr/bin/env bash
set -u

scenario=${TEST_SCENARIO:?}
state_dir=${TEST_STATE_DIR:?}
head_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
head_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
reviewer='vigil-review-bot[bot]'
printf '%s\n' "$*" >>"$state_dir/calls"

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
        printf '[{"name":"verify","workflow":"CI","bucket":"pending","state":"IN_PROGRESS","event":"pull_request","link":"https://example.test/run/1"}]\n'
        exit 8
      fi
      printf '[{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://example.test/run/1"}]\n'
      ;;
    wait-draft-then-ready)
      count=$(next_count checks)
      if [ "$count" -eq 1 ]; then
        printf '[{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://github.com/ceponatia/vigil/actions/runs/34716578875"},{"name":"verify","workflow":"CI","bucket":"pending","state":"IN_PROGRESS","event":"pull_request","link":"https://github.com/ceponatia/vigil/actions/runs/34716584247"}]\n'
        exit 8
      fi
      printf '[{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://github.com/ceponatia/vigil/actions/runs/34716578875"},{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://github.com/ceponatia/vigil/actions/runs/34716584247"}]\n'
      ;;
    wait-skipped-only)
      # One draft-triggered run's skipped verify, with no newer run for this head.
      printf '[{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://example.test/run/skipped"}]\n'
      ;;
    wait-verify-all-skipped)
      # Two runs for the same head, both with a skipped verify and no live verify
      # to supersede them (a draft run re-run, or a draft PR reopened, before the
      # ready-triggered run registers its own verify).
      printf '[{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://example.test/run/skipped-1"},{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://example.test/run/skipped-2"}]\n'
      ;;
    wait-peer-skipped)
      # The draft-then-ready shape (superseded CI/verify skip, live CI/verify
      # pass) plus another workflow's own skipped required check, which nothing
      # supersedes: the CI/verify skip is dropped, the peer skip is not.
      printf '[{"name":"verify","workflow":"CI","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://example.test/run/skipped"},{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://example.test/run/1"},{"name":"security","workflow":"Security","bucket":"skipping","state":"SKIPPED","event":"pull_request","link":"https://example.test/run/2"}]\n'
      ;;
    wait-failing|wait-stale)
      if [ "$scenario" = wait-stale ] && [ "$(next_count checks)" -eq 1 ]; then
        printf '[{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://example.test/run/old"}]\n'
        exit 0
      fi
      printf '[{"name":"verify","workflow":"CI","bucket":"fail","state":"FAILURE","event":"pull_request","link":"https://example.test/run/new"}]\n'
      exit 1
      ;;
    wait-unrelated)
      printf '[{"name":"documentation checks","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://example.test/run/1"}]\n'
      ;;
    wait-required-peer-fail)
      printf '[{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS","event":"pull_request","link":"https://example.test/run/1"},{"name":"security","workflow":"Security","bucket":"fail","state":"FAILURE","event":"pull_request","link":"https://example.test/run/2"}]\n'
      exit 1
      ;;
    wait-no-checks)
      echo 'no checks reported on the branch' >&2
      exit 1
      ;;
    *)
      printf '[{"name":"verify","workflow":"CI","bucket":"pass","state":"SUCCESS"}]\n'
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
