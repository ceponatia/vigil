The fault scenario matrix described in `docs/testing.md` — crash mid-write,
duplicate delivery, stale data, partial fill, and similar cases the system
must fail closed on; see `tests/README.md` for naming and how the root
Vitest config selects these.

A scenario belongs here when its claim is about what survives a failure or a
race, and it uses the real infrastructure the failure needs: the
concurrent-reservation scenario drives two independent Postgres connections
at one balance, because a lock the second transaction must wait on is the
only thing that can prove two strategies cannot spend the same funds.

## Where a scenario lives when only one app can drive it

A scenario belongs to the lowest layer that can actually drive it, and the
layer graph decides that before this directory does. Suites here may import
`@vigil/contracts`, `@vigil/db`, `@vigil/ledger` and `@vigil/market`; they may
not import an `adapter-*` package — only `apps/trading` may, because an
adapter is where venue credentials and execution authority live
(`eslint.config.mjs`, `docs/architecture.md` "Layer graph and import rules").

So the execution path's own fault scenarios — crash after exchange acceptance
but before local acknowledgement, and a partial fill followed by a
cancellation — live beside the code that owns them, in
`apps/trading/src/execution/execution-faults.int.test.ts`. They drive the real
paper adapter and the real schema and are selected by the same root Vitest
`integration` project as everything here; moving them under this directory
would mean teaching `tests/` to import an adapter, which is the one thing the
layer graph forbids.
