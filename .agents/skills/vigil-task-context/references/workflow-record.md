# Optional workflow context record

Use this record only when the parent requests a receipt for a substantive task
with verification requirements. It is evaluation data, not GitHub work state,
durable documentation, or memory.

The parent resolves the record path directly, from the repository root, as an
absolute gitignored path beneath
`eval-output/agent-context/<sha256(session_id)[:24]>/record.json`, keyed on the
shared root-session id (`CODEX_SESSION_ID` when present, else `CODEX_THREAD_ID`).
No hook in this repository computes, writes, or reads this path automatically;
the parent that requests a receipt owns creating, checking, and resetting it. A
read-only context scout may recommend a receipt or return proposed contents as
text, but does not write the file itself.

The JSON shape is:

```json
{
  "version": 1,
  "session_id": "exact shared root-session id",
  "brief": "brief.md",
  "requirements": ["docs", "tests"],
  "results": [
    {
      "requirement": "docs",
      "status": "verified",
      "evidence": "local artifact or CI URL",
      "reason": ""
    },
    {
      "requirement": "tests",
      "status": "unverified",
      "reason": "CI not yet run"
    }
  ]
}
```

`brief` is optional. When present, it is a relative Markdown path confined to
the same record directory and the file must exist. Allowed result statuses are
`verified`, `failed`, `unverified`, and `not-applicable`. `verified` requires
nonempty evidence; every other status requires a reason. Match results to the
declared requirements and the shared root session. Child thread IDs can differ
from the shared session ID; do not substitute one for the other when creating
a record.

Record paths are checkout-local. For work delegated to a different worktree,
include the parent's absolute record/brief path in the assignment rather than
assuming the other checkout contains the same evaluation files. The parent owns
completion evidence; a child does not overwrite the parent's receipt.

Update or reset the receipt when task scope changes. Record the checked full SHA
and relevant dirty delta in the brief or evidence when they affect a claim.
Evidence and brief text are self-reported pointers, not proof that the claim is
correct. No hook currently warns on a malformed or incomplete record in this
repository; a parent that relies on this record is responsible for checking it
itself before treating a requirement as satisfied.
