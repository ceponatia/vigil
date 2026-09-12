---
name: vigil-board
description: Create and classify Vigil issues, link branches and PRs, and update board status, assignment, or dependencies. Use for GitHub lifecycle operations; vigil-docs owns issue content and documentation placement.
---

# Vigil board operations

Board: **Vigil Development**, owner `ceponatia`. The board's repository,
project number, and project node ID are not yet known — set
`VIGIL_BOARD_REPO`, `VIGIL_BOARD_NUMBER`, and `VIGIL_BOARD_PROJECT_ID` in
[board.env](board.env) once the board and repository exist. Every helper in
this skill sources `board.env` and fails immediately with
`not configured: set <VAR> in board.env` instead of guessing when a required
value is still a `TODO(bootstrap)` placeholder. The helpers resolve option and
field ids through small direct GraphQL queries; do not copy static ids,
option lists, or dates into code.

## Field vocabulary (handoff §14.3)

| Field | Values |
| --- | --- |
| Status | Todo, Ready, In progress, In review, Blocked, Done |
| Horizon | Now, Next, Backlog |
| Phase | Bootstrap & Paper; Research Integration; Live Canary; Strategy Expansion; Controlled Learning |
| Area | Data, Ledger/Risk, Execution, Research, Evaluation, UI/Ops |
| Priority | Critical, High, Normal — avoid assigning everything Critical |

Use native dependency/blocking links, not row order or narrative notes.
Only mark actual verified completion as Done; a merged PR is not proof of
deployed runtime acceptance, and for this repository it never proves
live-trading readiness.

`vigil-docs` owns the body and structure of issues (the repository's issue
template mirrors handoff §14.6: Outcome; Context and authoritative
requirements; Scope; Out of scope; Dependencies; Acceptance criteria;
Verification; Safety / cost boundary); this skill owns creating and relating
issues and their board lifecycle. `vigil-pr-review` owns CI and review after a
PR exists. Existing user scope and authorization remain in force.

## Choose the operation

Run helpers beside this file from the repository root. Prefix examples with
`.agents/skills/vigil-board/`.

| Operation | Helper or procedure |
| --- | --- |
| Create, resume, and relate an issue | `file-issue.sh --title … --body-file … --parent N --blocked-by M …`; recover with `file-issue.sh --issue N …` |
| Set named fields or assignment | `board-set.sh N [--pr] [--assign or --unassign] Field Value …` |
| Preview field changes | `board-set.sh N --dry-run Field Value …` |
| Mirror issue classification to a PR | `link-pr.sh PR ISSUE` |
| Start a branch or manage PR lifecycle | [Issue and PR lifecycle](references/lifecycle.md) |

For a complete issue, create its branch with `gh issue develop`; its
Development link can close the issue on merge. Partial delivery uses an
unlinked slice branch and `Part of #N`. Read the lifecycle reference before
creating either. Explicit user instructions for direct-main delivery override
that default for the task.

## Assignment and truthful completion

Assigned to the configured owner means the next action is the owner's. Assign
when built work awaits owner review/acceptance, or an owner ruling is the only
unblock. Implementation and discovery remain unassigned. Remove the assignee
when owner action sends work back to implementation. Do not assign the owner
for an action the agent is already authorized to complete.

Built is not accepted. Name the remaining acceptance action on the issue and
use the appropriate board state. Close only the scope actually delivered and
accepted; a partial PR must not erase remaining work. Set PR status from its
own lifecycle, because issue linkage does not inherit fields or status.

## API and recovery rules

Use the provided direct GraphQL/REST helpers. `gh project` subcommands can
report rate limiting while direct calls work; inspect the actual error and
budget and use the direct path. Do not retry a failed mutation blindly or wait
out a false rate-limit report. Sub-issue and blocked-by REST endpoints take
database IDs, not issue numbers; the helpers resolve them.

Read saved fields and relations after mutations. If issue creation succeeded
before another step failed, the helper reports recovery instructions and
prints the created issue number last on stdout while retaining the failing
exit status. Rerun with `--issue N` and the same classification/relation
options to complete that issue instead of creating a duplicate. Query live
labels as needed; no new taxonomy or workflow is implied.
