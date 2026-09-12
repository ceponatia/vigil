---
name: vigil-agent-build
description: Implement Vigil issues using delegated agents and isolated worktrees. Use when assigning implementation slices, building issues in parallel, or resuming an agent's corrections. Read-only exploration alone does not need this workflow.
---

# Build Vigil with agents

This skill owns implementation and integration. `vigil-board` owns issue,
branch, PR, and board operations; `vigil-pr-review` owns CI and review after
delivery. Use the user's existing scope, model choice, and authorization.
An explicit instruction to work directly in a shared checkout overrides the
default worktree procedure; assign disjoint paths and one integrator there.

## Establish the slice

1. Read the issue, its parent when needed, the relevant system reference, and
   the actual code. Carry settled owner rulings into the brief. Resolve routine
   implementation choices from that evidence.
2. Ask only about unresolved choices that materially change product behavior,
   architecture, cost, or irreversible actions. Hold the affected slice while
   continuing independent work. Do not re-ask a settled question or infer that
   every implementation choice needs an owner ruling.
3. Give independent agents disjoint file/module ownership. Put dependent
   slices in sequence. Tell every worker that others share the codebase and
   that they must preserve concurrent edits.

## Track the issue checklist

Treat the issue's checklist as working acceptance criteria. Read both checked
and unchecked items, preserving their exact text and order so partial updates
do not shift item identities. Before editing,
account for its inventory and move-map requirements. At implementation handoff,
review completion, and CI completion, reconcile each item with actual evidence.
A merged PR or a green aggregate alone does not complete every checkbox.

The parent owns issue-body updates unless the brief delegates one writer.
Workers report the exact checklist item, completed action, and evidence as they
reach each milestone; they distinguish pending parent-owned review/CI from their
completed implementation. Keep issue text and unrelated checkboxes intact: read
its latest body, change only evidence-supported items, and read the saved body
back. Use `vigil-docs` for issue content and `vigil-board` for lifecycle.

Leave unverified, blocked, or inapplicable requirements unchecked with a concise
reason and any remaining action. Link evidence already in the PR or CI run
instead of duplicating an inventory. Before the final handoff, reconcile the
saved checklist with the report, including when recovering old work or finishing
a previously merged issue. Never check a before-edit requirement retroactively
unless the recorded evidence proves it occurred before those edits.

## Prepare and delegate

- Use [the brief template](templates/agent-brief.md), filling the outcome,
  ownership, known decisions, allowed operations, and required report.
- Use `vigil-task-context` when a substantial slice needs focused source discovery
  or a fresh context handoff. The parent owns any optional context/evidence record.
- For ordinary issue implementation, read [worktrees and integration](references/integration.md).
  Helpers are beside this file and run from any checkout; the worktree lands
  under the main checkout's `.claude/worktrees/`:

  ```bash
  .agents/skills/vigil-agent-build/worktree-up.sh <issue> <slug>
  .agents/skills/vigil-agent-build/worktree-up.sh <issue> <slug> --slice
  ```

- Read [Codex collaboration](references/codex.md) before delegating. Use the
  collaboration tools and parameter schemas available in the current session.
- On Claude, spawn `vigil-builder` for a bounded slice, `vigil-escalation`
  (with the escalation record or a `Risk area:` line) for risk-area slices or
  after a failed attempt, and `vigil-reviewer` for the semantic pass before
  integrating a code diff. Never pass `model` to these roles.
  `AGENTS.md` §Subagent model policy (Claude) owns the role table and
  escalation triggers, and the Agent-tool preflight `.claude/hooks/agent_policy.py`
  refuses other routes.
- The parent owns push, external messages, board changes, and delivery unless
  explicitly delegated. Do not ask the user again for actions already authorized.

## Review and correct

Review each completed diff before integrating it. Run
`.agents/skills/vigil-agent-build/scan-diff.sh <worktree>` for control
characters and other mechanical hazards, then inspect:

- Scope and ownership: all promised behavior is present and extra work is absent.
- Fail-closed resilience: a financial-authority path blocks new risk on
  invalid market, account, or chain state; a research or provider failure
  degrades instead of disabling deterministic risk management or protective
  actions (`docs/resilience.md`).
- Money arithmetic: no floating point anywhere in the change; decimal strings
  on the wire, exact integer base units or a decimal type internally.
- Idempotency and reason codes: an approved economic intent stays immutable
  and consumable once, a retry is a versioned attempt on the same intent, and
  every policy-eligible candidate is journaled before its outcome is known.
- Tests: the owning layer protects the defect; read `vigil-testing` before
  creating or reviewing tests. No local application gates, including Vitest.
- Docs: `vigil-docs` owns the durable-doc rules and their date exceptions.
- Migrations: generated SQL matches the schema change; no automated answers to
  Drizzle's ambiguous create-versus-rename prompt; use `vigil-db-change`.
- Secrets and personal data: absent from fixtures, logs, docs, issues,
  screenshots, and commits.

Send corrections to the same agent. If it is no longer available, give its
replacement the original brief, branch, and concrete findings. On Claude, a
replacement `vigil-builder` gets the brief and findings; once a builder or
correction worker returns an escalation record or reports a failed attempt,
that finding goes to `vigil-escalation` with the record, never to another
builder. That escalation round is the last automated one on a finding: if it
does not close it, stop the loop and report the open finding with its record
to the owner. Continue the correction loop inside the authorized task and
that cap.

## Integrate and finish

Integrate in dependency order and review the combined diff; a merge can
reintroduce a defect fixed in a slice. Keep edits, inspection, and commits
sequential so they cannot race. Follow [integration and delivery](references/integration.md)
when combining branches or preparing a PR.

Report the delivered commits, behavior, actual validation, and any remaining
scope accurately. Remove completed worktrees with
`.agents/skills/vigil-agent-build/worktree-down.sh` after integration; it keeps
branches by default. Work state and acceptance belong on GitHub, according to
`vigil-docs` and `vigil-board`.
