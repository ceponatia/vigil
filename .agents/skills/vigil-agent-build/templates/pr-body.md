## Summary

<Three to six lines: what an operator or owner gets, and the shape of the
change (new module, moved seam, migration number). Written for the owner
reading the diff cold.>

## Closes

Closes #<A>.
Closes #<B>.

<!-- One keyword per issue, each on its own line — `Closes #A, #B` links only #A.
     A slice that does not finish its issue says `Part of #N` instead, and names
     what is still owed under "Not in this PR". -->

## Safety / cost boundary

- Operating mode: <PAPER | SHADOW | PAUSED | LIVE — LIVE requires the explicit
  capability gate in `docs/policy.md`; it is never enabled by an environment
  variable alone>.
- Authority this PR does NOT enable: <venue credentials, signing capability,
  raised limits, live funds, or paid provider spend this change explicitly does
  not grant access to — state `None` only when every such authority was already
  excluded before this change>.

## Material decisions

- <Settled owner ruling or material implementation decision a reviewer needs
  to assess, with its reason and location. Do not ask the owner to reconfirm
  settled rulings or routine implementation choices.>

## Owner action still required

- <Only an unresolved material decision, missing authorization, credentialed
  action, or other owner-only step. State `None` when the existing request
  authorizes every remaining action the agent can perform.>

## Not in this PR

- <Scope deliberately left out, with the issue that still owns it.>

## Verification

No local application gates run. <Name the exact CI jobs that ran at the current
head SHA — `lint`, `static checks`, `unit tests`, `integration`, or the
aggregate `verify` — and what each covered; an unselected suite remains
unverified even when `verify` is green.> <Name the specific authorization,
credential, cost, or owner-only action that prevented any remaining
verification. Complete authorized verification instead of handing it back
generically.>

<!-- If evaluation output was produced: say what, and where it sits
     (eval-output/…, never docs/, never git). -->

## Review corrections

<!-- Append one line per round: "Round 1 (Codex, <date>): P1 <defect> → <sha>;
     P2 <defect> → <sha>. Threads replied + resolved." -->
