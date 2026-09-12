---
name: vigil-pr-review
description: Handle Vigil PR CI failures, review comments, review freshness, and authorized merges. Use after a push or when checking CI or closing review threads, including on merged PRs.
---

# Vigil PR review

Start by reading the PR's current state. Preserve authorization already given
in the session: do not ask again for an action the user already approved. The
owner marks drafts ready and merges by default, while an explicit user
instruction to do either action overrides that default.

Every helper sources [review.env](review.env) (or the fixture named by
`$VIGIL_REVIEW_ENV`, used only by tests) and fails immediately with
`not configured: set <VAR> in review.env` when `VIGIL_REVIEW_REPO` is still a
`TODO(bootstrap)` placeholder. `VIGIL_REVIEWER_LOGIN` is different: leaving it
unconfigured only degrades `review-status.sh`'s final classification line to
`unverified` with a clear message — it does not fail CI or thread checks,
which do not need a reviewer identity.

Use the helpers from this skill directory:

| Need | Command |
| --- | --- |
| Wait for required CI | `wait-ci.sh <pr>` |
| Read failed CI logs | `ci-failure.sh <pr>` |
| Classify review state | `review-status.sh <pr>` |
| Read review threads | `threads.sh <pr> [--all]` |
| Reply and resolve | `reply-resolve.sh <pr> <id> --body "…"` |

Only `reply-resolve.sh` mutates GitHub. Use a skill-relative path such as
`.agents/skills/vigil-pr-review/wait-ci.sh 42`.

## Required CI rule

`.github/workflows/ci.yml` runs `classify changes`, `lint`, `static checks`,
`unit tests`, and `integration`, then aggregates the applicable results into
`verify`. `wait-ci.sh` succeeds only when every required check is successful
and the required `CI / verify` aggregate reports `SUCCESS` for one unchanged,
full PR head SHA. A skipped or cancelled `CI/verify` superseded by a live
`CI/verify` for the same head is dropped before judging. Pending exit 8 and
failing exit 1 from `gh pr checks` can contain valid JSON and are parsed.
Missing checks, unrelated successful checks, stale-head results, drafts,
conflicts, timeouts, and repeated API errors never become green. A draft PR
has no checks by design — mark it ready before waiting.

Run the helper as a long-running background process and continue monitoring
that same session until it exits. Keep the user updated during a long wait.
Do not create a separate monitor around the probe.

Never run this repository's lint, test, typecheck, build, or verification
gates locally. CI is the gate. When it fails, use `ci-failure.sh`, read the
code, fix, push, and wait on the new full head.

## Review rule

Run `review-status.sh` after CI. It paginates review data and distinguishes
`unrequested`, `pending`, `findings`, `clean`, and `unverified` using the
configured reviewer identity and current full head.

For every finding you implement, reply on that thread after pushing, name the
fix commit and location, then resolve it. Never silently fix a thread and
never resolve one you did not address. Reply with reasoning and leave it open
when owner judgment is still needed.

Correction rounds are capped per finding: two on `vigil-builder`, then one on
`vigil-escalation`. When that round does not close the finding, stop the
loop — leave the thread open with the escalation record and hand the PR to
the owner for review and next steps instead of requesting another review
pass. The root instructions' subagent model policy owns the cap.

Read [references/operations.md](references/operations.md) when CI fails,
review findings exist, another review pass is needed, the branch moved
concurrently, or a merge is authorized.

## Completion

A PR is ready for owner acceptance when the current head is mergeable,
`wait-ci.sh` exits 0, review status has no unresolved actionable result, and
every addressed thread carries a commit-naming reply and is resolved. If the
user authorized merging, recheck those conditions immediately before the
squash merge and verify GitHub reports the PR merged. A merged PR is not
proof of deployed runtime acceptance, and for this repository it never proves
live-trading readiness — that determination belongs to the owner and the
board (`vigil-board`).
