# Brief: <issue or task> — <outcome>

## Goal and acceptance

- User goal: <observable outcome, in the user's terms>.
- Acceptance: <conditions that finish this assigned slice>.
- Issue checklist: <exact items that govern this slice; evidence needed for each>.
- Issue and settled decisions: <links/rulings when relevant; distinguish facts from assumptions>.

## Checkout and ownership

- Checkout: <absolute path>; mode: <isolated worktree | shared checkout>.
- Baseline: <full SHA>; relevant existing dirty state: <paths/delta or none>.
- Owned writable paths: <exact files/modules>.
- Adjacent owners: <other agents and paths>.
- Other agents share this codebase. Preserve their edits; do not switch branches,
  stage, commit, reset, stash, or clean unless that operation is assigned below.
  A checkout path in this brief does not change the spawned agent's cwd.

## Minimum context

- Read the root `AGENTS.md`, relevant nested instructions, and `docs/README.md`.
- Owning system reference: <specific page(s)>.
- Closest implementation or fixture: <path/symbol and why it matters>.
- Relevant skills: <only the matching workflow owners>.
- Open material questions: <unknowns and which work depends on them>.

Use the existing evidence to resolve routine choices. Challenge a material
unsupported premise with its impact and a smaller alternative. Do not reopen
settled choices without new evidence or expand this slice into adjacent work.

## Allowed operations and validation

- External/live operations: <explicit authorized scope or none>.
- Operating mode and authority: <paper by default; any venue credential, signing capability, live fund, or paid provider this slice is allowed to touch — normally none>.
- Commit/push/PR/board ownership: <parent or explicitly delegated actions>.
- Checklist writer: <parent by default; workers report milestone evidence for that writer>.
- Validation route: <exact permitted offline check, CI job/suite, or live verifier>.
- Unavailable validation: <what remains unverified and why>.
- Optional shared context/evidence record: <path supplied by parent, or none>.

Root policy and matching skills govern local application gates, test admission,
Drizzle ambiguity, docs placement, and delivery. A green aggregate does not prove
an unselected suite ran. An optional record grants no authorization; the parent
owns updating it. Continue independent work while a material question is pending.

## Return to parent

Report changed behavior and owned paths, commits or parent-owned commit status,
material decisions, actual validation with evidence, and anything incomplete.
Report each issue checklist item as completed with evidence or pending with a reason;
send milestone evidence during work rather than waiting until the final report.
Include actionable findings with paths and user impact. Inspect the scoped diff
for unrelated edits and unexpected control characters before reporting. Preserve
preexisting work and distinguish it from your contribution. On a first failed
attempt, or when the only remaining approach would change architecture or widen
scope, stop and return the escalation record below instead of trying again.

## Escalation record (escalation spawns only)

- Originating brief: <this brief, or a link/path to it>.
- Trigger: <what made this stop worth returning instead of continuing>.
- Findings: <what you learned about the actual problem>.
- Attempted approaches: <each approach tried and why it failed>.
- Changed files: <paths touched so far>.
- CI output: <failing workflow, run id, head and the observed failure — or none, with why no run exists>.
- Unresolved question: <what the next worker must decide or discover>.

Alternative, for a slice owned by `vigil-escalation` from the start rather
than handed off from a failed attempt:

Risk area: <ledger | policy | execution | signer | migration | authz | persistence | replay | idempotency | reconciliation> — <why>.
