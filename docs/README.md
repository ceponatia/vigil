# vigil documentation

This is the canonical documentation for vigil, an autonomous crypto research, trading, and yield-allocation application. It describes the product mandate, the architecture, and the policy that governs money and authority as they currently exist in this repository — not a roadmap, and not a restatement of any planning conversation that preceded the repository.

## Reading order

| Doc                                      | What it covers                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | Setup, environment variables, database bring-up, and the commands for running dev and tests |
| [product.md](product.md)                 | The sanitized product mandate: owner requirements, research universes, and success criteria |
| [architecture.md](architecture.md)       | Stack, directory layout, module boundaries, and data flow                                   |
| [resilience.md](resilience.md)           | The fail-closed and error-handling philosophy every module follows                          |
| [policy.md](policy.md)                   | Authority model, operating modes, numerical controls, and the canonical reason codes        |
| [capabilities.md](capabilities.md)       | Verified / Unsupported / Unverified status for every venue, tool, and carried-over claim    |
| [evaluation.md](evaluation.md)           | Point-in-time data integrity, the opportunity journal, and the validation protocol          |
| [testing.md](testing.md)                 | Test strategy and conventions                                                               |
| [decisions/](decisions/README.md)        | Architecture decision records for the contested calls that would otherwise be re-litigated  |
| [runbooks/](runbooks/README.md)          | Operational recovery, rotation, pause, and incident procedures                              |

## Documentation rules

- **Invoke the `vigil-docs` skill before editing anything under `docs/`.** It owns the authoring law this page does not: where a fact belongs, the reference-page shape, table formatting, and the validation checklist.
- **These docs say what is true now.** Present tense, no rollout plans, no history. Work state — status, priority, iteration, assignment — lives on the [Vigil Development board](https://github.com/users/ceponatia/projects/8) and in GitHub issues, never in a document.
- **A reference doc contains its own substance.** Never defer a page's content to a document the reader has to go find elsewhere; state it here.
- **Never name a retired document**, as a link or as plain text. If a rule came from one, state the rule instead of pointing at where it used to live.
- **Tables are formatted for the raw Markdown, not just the rendered page** — every row one physical line, pipes aligned in the source.
- **One focused document per system.** When a system's behavior changes, update its doc in the same change.
- **Promote a doc to a folder when it outgrows roughly 400 lines** — a `README.md` index plus one file per sub-topic, following the same pattern as `decisions/` and `runbooks/`.
- **A claim about a venue, fee, hold, network, or API is a verification item, not a fact, unless [capabilities.md](capabilities.md) marks it Verified.** Nothing is Verified yet.
- **Personal holdings and secrets never appear in docs.** Sanitized, general requirements only.
