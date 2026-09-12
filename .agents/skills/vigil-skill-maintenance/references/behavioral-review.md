# Review behavior at the affected boundary

## Discovery and runtime changes

- Confirm the active host's discovery locations and actual loaded skill catalog.
  Vigil's canonical sources are real directories in `.agents/skills`; `.claude/skills`
  entries link to them. A valid link alone is not runtime proof.
- Use the native `openai-docs` workflow for current Codex capability questions.
  Inspect local configuration and available tool schemas first. Do not replace
  a product name while retaining another host's API.
- For hooks, verify the configured event, matcher, trust/enablement state, and
  real payload on this host. Run a harmless representative event to prove
  attachment when authorized. A synthetic JSON fixture proves parser behavior
  only. Keep secret values and raw transcripts out of hook output.
- Check stale command paths, tool fallback claims, and unsupported model IDs.
  Only actual required MCP integrations belong in dependency declarations;
  optional connectors must not block a CLI-capable skill.

## Helpers

Locate existing fixtures beside the affected helper before creating new ones.
Use temporary files, fake executables, or disposable Git repositories without
application imports, services, credentials, or external writes. Test plausible
failure modes rather than matching implementation text.

Choose relevant cases rather than running this entire list after every edit:

- HTTP helpers: unsuccessful status, malformed response, bounded reauthentication,
  expired cookie, failure exit status, and no secret leakage.
- CI/review helpers: exact full head SHA, required check selection, skipped or
  absent jobs, reviewer identity, and stale review evidence.
- Board helpers: recoverable partial writes, resumable operations, clearing
  missing fields, readback mismatch, and upstream command errors.
- Worktree helpers: preexisting paths/branches, unrelated dirty state, an
  unconfigured `TODO(bootstrap)` repository failing clearly instead of
  guessing, and failures without destructive fallback.
- Structure helper: missing resources, a missing versus a broken compatibility
  link, scoped checks, and the CLI JSON/exit-status contract. Separately
  inspect local links and bare command paths in changed Markdown; resolve them
  from the containing file or documented working directory, excluding
  illustrative placeholders.

Do not convert a structural smoke test into a claim about external integration.
Application CI remains owned by `vigil-testing` and `vigil-pr-review`.

## Routing and instruction efficiency

Give the reviewer a small scenario with the user's request, authorization,
repository state, and available tools. Let it consult the skill catalog and
relevant entrypoints, but keep expected choices in the parent's evaluation.
Ask which skill owns the next step, which references are needed, what action is
supported, and what evidence would justify completion.

Use an intended trigger, a superficially similar request that should not trigger,
and a handoff to an adjacent owner. Add an unavailable-tool or partial-failure
scenario when the edited workflow depends on that boundary. Useful boundaries:
ordinary worktree creation versus stale branch recovery (`vigil-branch-recovery`);
a reason-code vocabulary edit versus a schema migration (`vigil-db-change`);
generic prompt wording versus host-specific model behavior; application edits
versus changes to the skill system itself.

Count unnecessary broad reads, duplicate calls, repeated permission requests,
unsupported assumptions, and false success claims as defects when they materially
affect the task. No finding is a valid result. Simulated selection and an actual
fresh-runtime invocation are different evidence; label them separately and leave
an unavailable runtime check unverified.
