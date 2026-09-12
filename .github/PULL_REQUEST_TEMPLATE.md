## Summary

<Three to six lines: what an operator or developer gets, and the shape of the
change (new package, moved seam, migration number). Written for the owner
reading the diff cold.>

## Closes

Closes #<A>.
Closes #<B>.

<!-- One keyword per issue, each on its own line — `Closes #A, #B` links only #A.
     A slice that does not finish its issue says `Part of #N` instead, and names
     what is still owed under "Not in this PR". -->

## Material decisions

- <Settled owner ruling or material implementation decision a reviewer needs
  to assess, with its reason and location. Do not ask the owner to reconfirm
  settled rulings or routine implementation choices.>

## Owner action still required

- <Only an unresolved material decision, missing authorization, credentialed
  action, or other owner-only step. State `None` when the existing request
  authorizes every remaining action the agent can perform.>

## Not in this PR

- <Scope deliberately left out, with the issue that still owns it — e.g. a
  gated live-canary step, a venue selection, a follow-up migration.>

## Verification

<!-- No local gates run on this repository — CI is the gate. Name the CI jobs
     that actually ran at the current head (`lint`, `static checks`,
     `unit tests`, `integration`, `verify`) and, for `unit tests` and
     `integration`, the specific suites or fixtures they covered. A job the
     classifier skipped is not verified by this PR, even if `verify` is
     green — say so plainly rather than implying broader coverage. -->

## Safety / cost boundary

<!-- Operating mode this change runs in (PAPER unless stated otherwise).
     State plainly what authority, credentials, live funds, or paid services
     this explicitly does NOT enable. Say whether any policy limit,
     capability row, or migration changed, and where. -->

## Review corrections

<!-- Append one line per round: "Round 1 (reviewer, 2026-09-12): P1 reservation
     double-spend on retry → a1b2c3d4; P2 stale-quote check order → e5f6a7b8.
     Threads replied + resolved." -->
