# Codex collaboration

This repository defines no custom Codex project roles (`.codex/agents/`).
Delegate on Codex using the session's default agent configuration; do not
invent or assume a named role that is not actually registered. Claude-side
roles under `.claude/agents/` pin their own model instead, and `AGENTS.md`
§Subagent model policy (Claude) owns that table. `.claude/hooks/agent_policy.py`
enforces the pins on Claude and is loaded by Claude Code only, so it grants no
equivalent guarantee on a Codex delegation — check the current spawn tool's
available options rather than assuming one host's guardrail applies to the other.

- Use `spawn_agent` for a concrete, bounded subtask that can proceed
  independently. Give code-changing workers explicit path or module ownership
  and tell them other agents share the codebase and their edits must be
  preserved.
- A worktree path in the brief binds the worker's commands and ownership;
  spawning does not change its working directory. Use the brief template so a
  worker with limited inherited context still receives the issue, decisions,
  restrictions, paths, and required report.
- Inherit the configured model. Override it only when the user requests a
  supported model, and follow `spawn_agent`'s context-fork restrictions.
- Use `send_message` to steer a running agent. Use `followup_task` to trigger a
  correction turn for an idle agent. Send findings back to the original worker
  when possible so it retains its implementation context.
- Use `wait_agent` for event-driven mailbox updates. Cap each wait at 60 seconds
  so progress updates remain possible; repeat bounded waits when work is still
  running instead of using an unbounded read. User steering ends the wait; answer
  it and continue the authorized task unless the user cancels or replaces it.
- Call collaboration tools directly in the commentary channel according to their
  current schemas. They are not shell commands and are not available through an
  execution-tool wrapper.
- Use the available user-input tool only for unresolved material choices. Existing
  authorization and settled rulings remain in force while delegated work runs.
- After an implementation slice lands, before reporting it complete, bring its
  tests up to date under `vigil-testing`. On Claude this runs as the pinned
  `vigil-test-keeper` role — the one role every coding task ends with. This
  repository defines no Codex-side equivalent, so do the reconciliation
  directly, or hand it to a Claude session, rather than spawning a role that
  does not exist.
