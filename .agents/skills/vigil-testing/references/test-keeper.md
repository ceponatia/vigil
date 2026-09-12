# Test keeper: bring the owning tests in line with a finished change

Read this when the `vigil-test-keeper` role runs, or when a coding task has
finished and its tests have not been reconciled. The role applies this
skill's admission and ownership rules to one concrete diff. It decides no
product behavior and changes no production code.

## The change under review

The change is what the parent names: a branch against its base, a worktree's
uncommitted edits, or a PR head. For a branch or PR head, inventory it with
`git diff --stat <base>...HEAD` and attribute every claim to that head SHA. A
dirty worktree needs `git diff --stat <base>` instead — base against the
working tree, so committed, staged, and unstaged edits are all included —
plus `git ls-files --others --exclude-standard` for untracked files, which the
keeper opens and inventories too; record the head SHA and state that the
report covers uncommitted changes on top of it, so nobody reads the report as
a claim about the commit alone.

## Procedure

1. **Inventory the change.** For each changed or new source file, list the
   behaviors that changed: a renamed or removed export, a new branch, a new
   reason code, a removed fallback, a schema field, a registry data edit.
   Read the code, not the commit message.
2. **Find the owning tests.** For each file: the co-located `*.test.ts`; the
   census and tripwire suites under `scripts/*.test.ts`; any `*.int.test.ts`
   that exercises the path; a `tests/replay/` or `tests/fault-injection/`
   scenario that exercises it; and consumers whose tests pin this module's
   output (grep for exported names, reason-code literals, and ids). Record
   which CI job selects each suite ([ci-evidence.md](ci-evidence.md)).
3. **Check coverage per behavior.** Every changed behavior has a test that
   fails against the old code; every removed behavior has no test still
   asserting it; every new fail-closed or degraded path has a test for its
   fallback and reason code. Apply the admission rules in
   [SKILL.md](../SKILL.md) and
   [admission-and-ownership.md](admission-and-ownership.md): nothing another
   gate already proves, the smallest regression test at the owning layer,
   registry-derived assertions over copied lists, structure over snapshots
   unless the literal is the contract
   ([existing-helpers.md](existing-helpers.md)).
4. **Update stale pins.** An assertion that pins retired behavior is rewritten
   to assert the current, intended behavior — never deleted to make a suite
   pass, never loosened past what it proved. When the new behavior is itself
   wrong, leave the assertion standing and report the defect with the failing
   expectation as evidence.
5. **Name the defect.** A new test file says in its header which defect it
   kills; a new `it` says the claim it protects.
6. **Verify without running.** Local Vitest, lint, typecheck, and builds are
   forbidden on this machine. Verify by reading: trace each updated assertion
   through the code path it exercises. When the change is on a PR, read the
   current head's CI with
   `.agents/skills/vigil-pr-review/ci-failure.sh <pr>` and reconcile every
   reported failure — until the GitHub repository and its CI exist, say so
   explicitly instead of citing a run. A suite outside the selected jobs is
   unverified and is reported as such.
7. **Report.** Per test file: the claim each changed or added test protects
   and the CI job that selects it. Then: behaviors with no owning test and why
   (another gate owns it, or a defect to fix); production defects found;
   suites left unverified. Never "all tests pass" without a CI run on that
   head — and there is no CI to run against until the repository exists on
   GitHub.

## What the role never does

- Change production code, configuration, migrations, skills, or docs; it
  reports what those would need.
- Weaken an assertion, delete a failing test, add a skip, or widen a matcher
  so a suite passes.
- Run an application gate locally, or claim a green aggregate covers a suite
  the classifier did not select.
- Expand into unrelated test debt; that is reported for routing.
