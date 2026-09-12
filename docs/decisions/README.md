[← Documentation index](../README.md)

# Decisions

This directory holds architecture decision records (ADRs) — durable, contested decisions recorded so they are not re-litigated every time the rejected alternative resurfaces.

## When an ADR is warranted

An ADR is for a contested, durable decision: one where a plausible alternative exists and someone will propose it again. A decision that is not yet settled starts as a `decision-needed` issue, not an ADR — an ADR records a decision that has been made, even one still awaiting the owner's final confirmation, not an open question. Ordinary implementation choices with no live alternative do not get an ADR; they are just how the code works, documented where the code is documented.

## Format

Each ADR is `NNNN-<slug>.md`, numbered sequentially with four sections:

- **Status** — `Proposed`, `Accepted`, or `Superseded by <NNNN>`
- **Context** — what forced the decision
- **Decision** — what was decided
- **Consequences** — what follows from it, including what it rules out

An ADR is never rewritten once accepted. A decision that reverses an earlier one adds a new numbered ADR and marks the original's status `Superseded by <NNNN>`, leaving the rest of the original document intact as the record of what was decided and why, at the time.

## Index

| ADR                                                       | Title                                     | Status   |
| --------------------------------------------------------- | ----------------------------------------- | -------- |
| [0001](0001-typescript-first-runtime.md)                  | TypeScript-first runtime                  | Accepted |
| [0002](0002-authority-boundaries-and-process-topology.md) | Authority boundaries and process topology | Accepted |
