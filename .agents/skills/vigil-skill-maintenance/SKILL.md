---
name: vigil-skill-maintenance
description: Audit and repair Vigil skill discovery, routing, references, and helper behavior. Use after skill, hook, or agent-runtime changes, or when agents select or follow skills incorrectly; ordinary application edits do not need this audit.
---

# Maintain Vigil skills

Keep the audit proportional to the changed skill, helper, hook, or runtime.
The native `skill-creator` owns skill authoring and Codex metadata format;
this skill owns repository compatibility and evidence of correct use.

## Establish scope

Read the root instructions and affected entrypoints. Identify the symptom or
change, affected callers, canonical sources, compatibility links, and current
host. Inspect only the supporting references needed for that route.

An audit begins read-only. Repair within the user's existing scope; do not
install tools, change runtime configuration, publish changes, or expand to
application code merely because a skill mentions those operations. Reuse prior
authorization without another confirmation.

## Check structure

From the repository root, run the read-only helper for affected skill names:

```bash
python3 .agents/skills/vigil-skill-maintenance/scripts/check_structure.py vigil-testing
```

Omit names to check all repository skills. It verifies real canonical directories
under `.agents/skills`, required files, and `.claude/skills` compatibility link
targets. Its JSON report and exit status describe
**structure only**. It does not validate YAML, reference paths, Markdown links,
runtime discovery, tool availability, or behavior.

A missing `.claude/skills/<name>` link reports as `missing-compatibility-link`,
not as a broken link: the parent creates those compatibility symlinks after a
skill's canonical directory and required files exist, so this state is expected
until that step runs. A `compatibility-link` issue means the link exists but is
wrong (dangling, or resolving to a different skill) — that always needs repair.

Use the current native `skill-creator` validator for frontmatter, then inspect
`agents/openai.yaml` against its schema: useful display name, concise description,
exact `$skill-name` in the suggested prompt, deliberate invocation policy, and
only genuinely required MCP dependencies. CLI commands and native collaboration
tools are not MCP dependencies.

## Check actual behavior

Read [behavioral review](references/behavioral-review.md) for the affected route.
Verify referenced paths and commands against the checkout, and tool names,
arguments, hook events, and payloads against the active host. Existing files or
a passing payload fixture do not prove discovery or hook attachment.
For this repository's hook wiring, read
[Codex runtime checks](references/codex-runtime.md).

Preserve one owner for each workflow. Descriptions should distinguish neighboring
skills; entrypoints should route to conditional detail rather than copying root
policy, commands, and large examples into every task.

Run affected dependency-free offline helper fixtures when helper behavior
changes. Do not run local application tests, lint, typecheck, builds, databases,
or live mutations as maintenance checks. `pnpm lint:docs` remains the documented
exception for documentation changes, once it exists.

For routing or instruction changes, delegate a bounded independent review with
representative positive, negative, and neighboring-skill prompts. Have the
reviewer explain selection, necessary context, next actions, and stopping
conditions. Compare decisions with intended ownership; do not supply the
expected answer to the reviewer. Label this as a simulated review unless actual
runtime selection and execution were observed.

## Report the result

Separate structural checks, helper fixtures, source-reviewed routing, observed
runtime behavior, and unverified stages. Include actionable defects and scope
limits; never compress all of these into "skills work." Keep task evidence in
gitignored `eval-output/` when a file is useful. Do not create a repository plan,
write memories, or store transcript dumps inside a skill.
