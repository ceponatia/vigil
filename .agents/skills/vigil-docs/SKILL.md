---
name: vigil-docs
description: Author vigil issues, sub-issues, durable documentation, and ADRs. Use when creating persistent work records, editing docs/, or deciding where information belongs; ordinary chat progress updates do not need this skill.
---

# vigil information ownership

GitHub owns work state; the repository owns technical truth; git owns history.
A future agent should be able to act from the issue, at most one parent, a
focused system reference, and the code. Keep each fact in one canonical home.

## Choose the artifact

| Information | Home |
| --- | --- |
| Outcome, scope, acceptance | Issue; a parent issue for a larger effort |
| Implementation stages | Native sub-issues |
| Dependencies | Native blocked-by relations |
| Current status, priority, iteration, assignment | Project board (Vigil Development), via `vigil-board` |
| Material unresolved owner choice | `decision-needed` issue |
| Research or design reasoning | Issue comments or a `research` issue |
| Resulting technical law | System reference under `docs/` |
| Contested durable architecture decision | ADR under `docs/decisions/` |
| Historical implementation detail | Git and closed issues/PRs |

Plan documents are retired. Do not create roadmap/status documents in the
repository. Evaluation outputs, including screenshots, belong in gitignored
`eval-output/`, as the root instructions require.

## Load only the needed procedure

- **Issue or sub-issue content:** read [issue authoring](references/issues.md).
  Use `vigil-board` for actual creation, classification, dependency operations,
  branch/PR links, status transitions, and assignment. Do not copy its board
  field names, IDs, or workflow assumptions into this skill.
- **A document under `docs/`:** read `docs/README.md`, then the owning system
  page and [durable document rules](references/durable-docs.md). That reference
  owns the no-dynamic-state rule, its date exception, style guards, and
  validation checklist. Use [the reference template](templates/reference-doc.md).
- **An ADR:** also read `docs/decisions/README.md` and use
  [the ADR template](templates/adr.md). An unresolved choice starts in an issue;
  an ADR records the settled decision when its rationale merits preservation.

## Finish within scope

For a system behavior change, update its owning reference in the same change.
When two pages define the same fact, retain one owner and link to it; do not
maintain synchronized copies. Index added pages at their own tier according to
`docs/README.md`.

No CI exists yet for this repository — it is not a git repository and has no
GitHub remote, so no workflow has ever run. `pnpm lint:docs` is not a script
that exists in this repository today; the root process rules permit running it
locally once it is added. Until then, walk every relative link and
`<file>.md §<Heading>` citation you touched by hand and confirm the target
exists (see [durable document rules](references/durable-docs.md) for the exact
checks). Issue-only work requires verification of the saved issue and native
relations instead. Neither route authorizes unrelated issue filing, publishing,
production actions, or extra owner confirmations; follow the current request.
