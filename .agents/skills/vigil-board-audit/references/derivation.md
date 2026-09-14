# Derivation rules and finding codes

`board-audit.py` never guesses silently: every suggestion names the rule that
produced it, and a suggestion is offered only when its value is one of the
board's live option names. A renamed option turns the suggestion into
"no live option named …" and the finding into report-only.

## How each classification field is derived when unset

| Field | Rule, in order | Never |
| --- | --- | --- |
| Status | Closed issue: no suggestion. Open parent with an open sub-issue: `Todo` (a parent is worked through its children). Open with an open native blocker: `Waiting on dependency`. Open with the `decision-needed` label: `Needs decision`. Open, unblocked, all eight body sections present and non-empty: `Ready`. Open, unblocked, body incomplete: `Todo`. | `Done`, `In progress`, `In review` — those track work and acceptance, not filing. |
| Horizon | The parent's Horizon when the parent is in the batch and has one. Else the title's leading `PREFIX-NN:` planning ID: `BOOT` → Now, `NEXT` → Next, `BACK` → Backlog. A planning ID mentioned later in a title ("…, BOOT-07 shipped read-only local") describes another issue and derives nothing. | A value with neither a parent nor a planning ID; report instead. |
| Phase | The parent's Phase when set. Else by planning ID: every `BOOT-xx` → Bootstrap & Paper; `NEXT-01` → Research Integration; `NEXT-02`, `NEXT-03` → Live Canary; `NEXT-04` → Controlled Learning; `BACK-01`, `BACK-02`, `BACK-03` → Strategy Expansion; `BACK-04` → Controlled Learning. | A guess for an issue with no planning ID; report instead. |
| Area | Keyword scores over the title, Outcome, and Scope only (Context and Out of scope name neighbouring areas on purpose). Offered when one area scores at least 2 and strictly beats the runner-up. An issue with sub-issues may leave Area unset (`info`, not a finding). | An ambiguous tie — the report shows both scores; choose by hand. |
| Priority | `High` when the issue natively blocks two or more open issues in the batch; otherwise `Normal`. | `Critical` — an owner call, never derived (handoff §14.3). |
| Size | Never derived. It is the filing brief's estimate of agent time: S ≈ 10 minutes, M ≈ an hour, L ≈ half a day, XL ≈ a day. XL is the cap; larger work is a parent with sub-issues, and a parent carries no Size (`info`). | A guess from the body's length. |
| Owning role | `Owner` with the `decision-needed` label; `Research` with the `research` label; `Escalation` when the title, Outcome, or Scope names two or more distinct AGENTS.md risk areas (ledger, policy, execution, signer, migration, authz, persistence, replay, idempotency, reconciliation); `Builder` when it names none. A parent may leave it unset (`info`). | A single mention is ambiguous (an import of `policy` is not a policy change); the report shows it and the parent chooses. |
| Evidence | Never derived. Required (as a finding, not fixable) once Status is `In review` or `Done`; ignored before that. | — |

The keyword table lives in the script (`AREA_KEYWORDS`): package paths
(`packages/market`, `packages/ledger`, `adapter-`, `apps/control` …) and the
vocabulary of each area. Extend it there when a new package or area appears.

## Relations

- **Blockers named in the body.** The clause after each `Blocked by:` in the
  Dependencies section, up to the first sentence end, ` — ` aside, semicolon,
  or line break. Planning IDs resolve through the batch's titles (their
  leading `PREFIX-NN:` prefix); `#N` resolves directly. A parenthetical right
  after an issue number annotates it and is dropped before the clause end is
  looked for: "Blocked by #10 (BOOT-07 — prerequisite)." names only #10.
  "Blocked by: BOOT-04. BOOT-06 is optional context" names only BOOT-04.
- **Parent named in the body.** `Part of #N`, `Sub-issue of #N`,
  `Parent: #N`, `parent issue #N` — in the Dependencies section only. A
  Context sentence quoting a PR's own "Part of #N" line describes that PR,
  not this issue's parent. With `--parent N`, every other issue in the
  batch is expected to have N as its native parent.

## Finding codes

Severity `finding` sets exit status 3; `info` never does. "Route" is what the
auditor does with it.

| Code | Severity | Fixable | Route |
| --- | --- | --- | --- |
| `not-on-board` | finding | yes | `board-set.sh N` adds the item |
| `missing-field:<Field>` | finding | when a suggestion exists | `board-set.sh N Field Value` |
| `area-unset-on-parent`, `size-unset-on-parent`, `owning-role-unset-on-parent` | info | — | leave; a parent spans areas, sizes, and roles |
| `planning-id-mid-title:<ID>` | info | — | the title mentions a planning ID without leading with it, so nothing is derived; retitle `<ID>: …` only if the issue owns that work package |
| `missing-field:Evidence` | finding | no | report; set it with `board-set.sh n Evidence "<pointer>"` once the justification is known |
| `field-vs-derivation:<Field>` | info | — | report; reclassify only on instruction |
| `label-outside-taxonomy:<label>` | finding | no | report; never remove a label |
| `body-section-missing:<Section>` / `body-section-empty:<Section>` | finding | no | report for `vigil-docs` / the filer |
| `body-blocker-unlinked:#N` | finding | yes | `file-issue.sh --issue n --blocked-by N` |
| `body-blocker-unresolved:<ref>` | finding | no | the ref's issue is outside the batch or unfiled; report |
| `body-blocker-self:<ref>` | finding | no | report; the body is wrong |
| `native-blocker-unnamed:#N` | info | — | report; bodies may omit a link |
| `parent-unlinked:#P` | finding | yes | `file-issue.sh --issue n --parent P` |
| `status-vs-blockers` | finding | yes | `board-set.sh n Status "Waiting on dependency"` — Todo or Ready while a native blocker is open |
| `waiting-without-open-blocker` | finding | yes | `board-set.sh n Status Ready` (or Todo when the body is incomplete) — every blocker closed |
| `todo-but-unblocked` | info | — | suggest Ready (leaf issues only, never a parent with open sub-issues); apply only if the brief allows Status changes |
| `needs-decision-without-label` / `decision-label-outside-needs-decision` | info | — | report; the label and the Status should agree |
| `done-but-open` | finding | no | report; acceptance is the owner's |
| `closed-not-done` | info | — | report |
| `assigned-outside-owner-turn` | finding | no | open issues only; report; `--unassign` only with authorization |
| `owner-turn-unassigned` | finding | yes | open issues only; `board-set.sh n --assign` — In review or Needs decision means the owner acts next |
| `duplicate-planning-id:<ID>` (batch) | finding | no | report; one of the twins is a duplicate for the filer to close |
