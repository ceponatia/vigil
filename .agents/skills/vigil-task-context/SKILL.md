---
name: vigil-task-context
description: Prepare a compact Vigil brief for a fresh agent, resumed session, or bounded handoff. Use when context must cross an agent or session boundary; ordinary progress summaries do not need this workflow.
---

# Prepare Vigil task context

Give the next agent enough verified context to start without replaying the full
conversation. Use the parent-provided task and inspect only the repository paths
needed to resolve its material fields. Do not dump transcripts, broad history,
tool logs, or speculative background.

Return the brief as text with these fields:

- **User goal:** the requested outcome, in the user's terms.
- **Acceptance:** observable conditions that finish the assigned slice.
- **Current SHA:** full checkout SHA, plus relevant dirty paths when the SHA does
  not describe the files the next agent will see.
- **Owned files:** exact writable paths and explicit adjacent owners.
- **Relevant docs:** only the root, system, skill, or issue sources needed.
- **Closest example:** the most useful existing implementation or fixture.
- **Decisions:** settled user/owner rulings and unresolved material choices.
- **Constraints:** repository rules and task-specific limits that change action.
- **Operating mode and authority:** PAPER unless the parent states otherwise;
  credentials or live funds the slice may touch (normally none).
- **Authorization:** allowed external actions, mutations, commits, and delivery.
- **Actual validation route:** the exact offline check, CI job, or live verifier
  that can prove the result; label unavailable stages unverified.

Separate observed facts from assumptions. Use full identifiers where staleness
matters, and say `unknown` rather than filling a gap from memory. Credentials,
secrets, raw transcripts, and unrelated dirty files do not belong in the brief.

For a substantive task whose parent requests an optional verification receipt,
read [workflow context records](references/workflow-record.md). Otherwise return
the brief directly and create no record. Do not write the brief to an issue or
other persistent system unless the user explicitly requests that action.

Finish when another agent can begin the bounded slice and determine completion
from the brief alone. Context preparation does not implement the task, mutate the
repository, or broaden the supplied authorization.
