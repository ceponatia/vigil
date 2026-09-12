# Issue authoring

Read when creating or restructuring issues and sub-issues. `vigil-board`
owns creation commands, board classification, links, lifecycle, and assignment.

## Use the handoff issue template

Every issue body uses this structure, taken from the project handoff's issue
template:

```markdown
## Outcome
The user-visible or operational result this issue delivers.

## Context and authoritative requirements
Relevant handoff section / requirement IDs. Identify open decisions explicitly.

## Scope
The smallest implementation needed for this outcome.

## Out of scope
Adjacent ideas intentionally deferred.

## Dependencies
Existing issues / capabilities, distinguishing hard blockers from optional context.

## Acceptance criteria
- [ ] Observable behavior and supporting test/evidence.
- [ ] Relevant failure/recovery behavior.
- [ ] Canonical documentation updated if behavior changed.

## Verification
Commands, fixture/replay, capability evidence, or safe manual checks.

## Safety / cost boundary
What authority, credentials, live funds, or paid services are explicitly not enabled.
```

- **Outcome** names who benefits — "the owner," "an operator," or "a
  developer." There is no other kind of end user in this product; never write
  one in.
- **Context and authoritative requirements** cites the handoff section or
  requirement IDs it draws from. Cite the handoff's planning IDs (`BOOT-01` …
  `BOOT-08`, `NEXT-01` … `NEXT-04`, `BACK-01` … `BACK-04`) as planning IDs, not
  as issue numbers — they identify a work package in the handoff, not a
  GitHub issue. Never invent a GitHub issue number, URL, or project ID; leave
  an explicit `TODO(bootstrap): …` placeholder where one is genuinely unknown.
- **Acceptance criteria** must be proportional to the risk and scope of that
  specific slice. Do not manufacture a long checklist of generic work for a
  small slice. A criterion that touches live funds, real credentials, or a
  paid provider must say so explicitly rather than leaving it implicit in the
  scope text.
- **Safety / cost boundary** is not decorative: state plainly what stays off —
  PAPER-only, no live credentials, no capability-gate change, no spend against
  the operating budget — even when it feels obvious from scope.

## Make the next implementation concrete

A plan-sized effort is a parent issue. Keep its body concise enough to
navigate without reading historical documents, using the structure above.

- Create implementation stages as native sub-issues alongside the parent when
  enough is known to describe them. A child states its own scope, dependencies,
  and acceptance; do not maintain a duplicate checklist of its status.
- Add discovered prerequisites as work items with native blocked-by relations
  on the exact dependent issue. Prose and list order are not dependency links.
- A material unresolved choice belongs in a `decision-needed` issue with the
  plausible choices, consequences, and relevant code — for example, which
  venue, chain, stablecoin, or signer provider to approve. Reuse existing
  owner rulings; resolve routine implementation decisions within the
  authorized task.
- Record owner rulings as dated comments on the owning issue. Update a durable
  reference only when the ruling changes technical law; preserve rationale in
  an ADR only when it warrants one.
- A research issue holds experiments and discussion. Once resolved, resulting
  behavior belongs in system docs, resulting work in issues, and history in the
  closed issue. A reproducible measurement may earn a text-only evidence
  record only where `docs/capabilities.md` records the fact as Verified — see
  [durable docs](durable-docs.md).
- When the task authorizes filing unrelated findings, label those `agent-found`.
  Do not expand an implementation task into a debt cleanup project.
- GitHub Discussions are not used; decisions there are unavailable to part of
  the agent fleet. Use issues and comments.
- Never let personal holdings, real credentials, or any quantity, date-specific
  priority, cost basis, or asset-specific detail from the private handoff's
  appendices reach an issue. Write sanitized, general requirements instead.

## Acceptance and saved state

Built and accepted are distinct. Do not imply completion while an acceptance
action remains. `vigil-board` owns the actual lifecycle transition and whether
a PR should close an issue. Use one closing keyword per completely delivered
issue; partial scope must retain an open work record.

After an authorized mutation, read the saved issue and native relations back.
If creation succeeded but classification or linking failed, resume from that
issue's number rather than filing a duplicate. Let board helpers own recovery.
