# Durable documents

A reference page states **what the system currently guarantees** — boring,
present-tense law an agent can check code against. It tells no story of how the
feature was built, lists no alternatives, and records no progress. Template:
[reference template](../templates/reference-doc.md).

`docs/README.md` is the index and owns the tree itself: the reading-order table
of top-level areas, the one-doc-per-system rule, and the ~400-line
file-to-folder promotion rule. Read it before adding a page, and index the new
page in the same change — in the index for its tier. A **new top-level system**
gets its row in `docs/README.md`'s reading-order table, which indexes areas and
nothing finer. A **new part file inside a promoted folder** gets its row in that
folder's own `README.md` index instead; the root table keeps pointing at the
folder's `README.md`, so a nested page never earns a root row.

- **Shape:** one paragraph of orientation; an "Owns / does not own" section
  naming the boundary and the owning page for what it excludes; then laws as
  short declarative bullets grouped by aspect. Target 100–200 lines, well
  inside the promotion threshold.
- **One canonical owner per fact.** If two pages define the same thing, stop
  and designate the owner — delete the other side and link to the owner. Never
  resolve a conflict by making both sides agree.
- **Docs do not link into work state.** No issue or PR references as content —
  git blame is the provenance. Issues point at docs, not the reverse.

### No fact without a verified source

A durable doc never states a fee, rate limit, network/chain support claim, or
provider API behavior as settled fact unless `docs/capabilities.md` records
that exact claim as **Verified**. Anything else — a candidate fee schedule, an
assumed limit, a provider capability nobody has exercised against the real
API — is written as a claim to verify, not as law: "the provider is expected
to…", "unverified: …", or an explicit pointer to the open verification item.
An example risk number, position size, or threshold copied from planning
material is always labeled **unapproved** wherever it appears; no venue, chain,
stablecoin, router, signer provider, trading framework, or risk percentage has
been selected, and a reference page must not write one in as though it had.

### The no-dynamic-state rule

A durable doc may **never** contain: `Status:` lines · "next" / "remaining
work" / "not started" · slice or stage numbers · rollout checklists · roadmap
priority · current blockers · "awaiting owner" · PR or issue state. All of that
is board state.

The distinction that matters — an architectural **requirement** belongs in the
page; **project state** does not:

- Belongs: "An approved intent is immutable and consumable once; a retry is a
  versioned attempt on the same intent."
- Does not: "Blocked because the reservation ledger isn't implemented yet."

#### Dates: the one exception

A durable page is written in the present tense and carries no dates — a date on
a statement of current law is either history or a freshness claim the reader
cannot check. **Exactly one kind of line may carry one**, and this is
canonical: `docs/README.md` and `docs/decisions/README.md` point at it rather
than restate it, and no page under `docs/` may add a second.

- **Owner rulings** stated in a reference page, dated at the attribution — an
  `Owner ruling <YYYY-MM-DD>:` line, or an inline `(owner ruling
  <YYYY-MM-DD>)`. The date attributes the decision; the law it produced is
  still written in the present tense around it.

Every other date is banned: when work happened, when it will happen, when a
page was last reviewed, or how current its contents are. An ADR is its own
document class and is dated by design at the top of its template — see ADRs
below — that date is not a second exception to this rule for an ordinary
reference page.

### Style guards

- **No conversation in the record:** no "as discussed" / "you said" / "let me
  know", no agent narration, no standing `TBD` — an undecided thing is a
  `decision-needed` issue, not a placeholder. Owner rulings appear as dated
  ruling lines, not remembered dialogue.
- **Tables are read raw:** 2–4 columns, short cells, every row one physical
  line, pipes padded so the source aligns, literal pipes escaped `\|`. If
  several cells need prose, it is a list, not a table.

## ADRs — sparingly

`docs/decisions/NNN-<slug>.md`, template [ADR template](../templates/adr.md): Decision, Context,
Alternatives considered, Why this choice, Consequences — 30–100 lines.

An ADR exists to **prevent re-litigation**, not to record history. "Every
approved intent references exactly one economic action ID and is consumed at
most once" earns one, because someone will propose relaxing it later for
convenience. "Use a 30-second quote freshness window instead of 60" does not —
that number belongs in the relevant reference page, and is labeled unapproved
until a venue and policy are actually selected. Most owner rulings never
become ADRs.

## Validation

Before finishing any change this skill governed:

- **Check links and citations by hand.** No `pnpm lint:docs` script exists in
  this repository yet, and no CI job runs one — the repository is not on
  GitHub and no workflow has executed. Until the script and CI exist, walk
  every relative link you touched and confirm the target file exists; for a
  `<file>.md §<Heading>` citation, confirm the named file exists and actually
  has that heading (a heading may be a prefix match, since prose has no
  closing delimiter for `§`, but it must exist).
- **No dynamic state in any durable doc you touched** — check against the
  banned list above, and search touched files for `Status:`, `slice`,
  `remaining`, `awaiting`, `blocked on`.
- **No unverified fact stated as settled** — search touched files for a fee,
  limit, network/chain-support, or API-behavior claim that is not attributed to
  a `docs/capabilities.md` **Verified** entry, and for an example risk number
  or threshold missing its **unapproved** label.
- **Issues you filed are complete:** on the board with fields set, sub-issues
  linked to their parent, dependencies wired as relations, labels applied.
- Tables you touched are aligned or converted to lists; no residue phrases in
  anything you wrote.

For repository documentation changes, review the changed Markdown yourself;
there is no CI to lean on until the GitHub repository exists and a workflow has
run against it. Issue-only work does not need repository documentation
validation.
