# Vigil Codex runtime configuration

`.codex/hooks.json` wires a `PreToolUse` hook on `Bash` to
`.codex/hooks/preflight.py`, a symlink to the canonical `.claude/hooks/preflight.py`;
compatibility callers on either host run the same implementation and cannot
drift apart. There are no custom Codex agent TOMLs (`.codex/agents/*.toml`) in
this repository: delegation on Codex uses the session's default agent
configuration rather than a named project role.

## What the hook does

- `preflight.py` runs before a `Bash` tool call on either host. Read its own
  source and `AGENTS.md` (local-gate and secrets/personal-data rules, and the
  refusal of a sweep commit) for the exact checks it enforces, rather than
  restating them here — they change with the hook, and this reference would
  drift.
- The Claude-only Agent-tool preflight, `.claude/hooks/agent_policy.py`, pins
  `vigil-builder`, `vigil-escalation`, `vigil-reviewer`, and `vigil-test-keeper`
  to their required models and refuses an implementation brief sent to an
  un-pinned agent type, a `vigil-escalation` spawn with no escalation record or
  `Risk area:` line, and an explicit `model` override on a pinned role. It is
  not loaded on Codex, so no equivalent guard runs there.
- `vigil-task-context` owns the optional workflow-context record format (see
  its `references/workflow-record.md`) and the gitignored `eval-output/`
  location it lives under. No hook in this repository reads, writes, or warns
  on that record; the parent that requests a receipt is responsible for
  creating, checking, and resetting it.

## Validate each boundary

1. Parse `.codex/hooks.json` and check the configured event, matcher, and
   handler path. Preserve unrelated settings and avoid duplicate hook sources.
2. Run the dependency-free fixtures against the canonical implementation
   (`.codex/hooks/*.py` are symlinks to the same files, so this covers both
   hosts):

   ```bash
   python3 -B -m unittest discover -s .claude/hooks -p 'test_*.py'
   ```

3. Use the current host's `hooks/list` API or CLI `/hooks` to inspect effective
   definitions, parse errors, enablement, and trust. Read-only discovery does
   not grant trust or execute a handler. Match shell/exec preflight as `Bash`.
4. Complete the host's supported trust review for changed hook definitions
   before claiming activation. Do not bypass trust checks or edit private
   trust storage.
5. This repository has no custom Codex role to select, so verify Codex
   delegation against the default agent configuration only. Verify the four
   pinned Claude roles by selecting each in a fresh Claude session and
   observing harmless startup, spawn, and completion events. If that stage is
   not available, report structural/fixture/discovery results separately from
   activation.

Consult the current [hook documentation](https://learn.chatgpt.com/docs/hooks)
and [custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
for the active host's schema. The project does not raise concurrency, change
global approval policy, or use model-driven review hooks after each edit.
