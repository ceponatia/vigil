Deterministic, full-lifecycle replays that drive a scenario end to end
through real repository seams — from a research candidate to a journal
entry — asserting on the final state rather than on each intermediate step;
see `tests/README.md` for naming and how the root Vitest config selects
these.

## Where a scenario lives when only one app can drive it

A scenario belongs to the lowest layer that can actually drive it, and the
layer graph decides that before this directory does. Suites here may import
`@vigil/contracts`, `@vigil/db`, `@vigil/ledger` and `@vigil/market`; they
may not import an `adapter-*` package — only `apps/trading` may, because an
adapter is where venue credentials and execution authority live
(`eslint.config.mjs`, `docs/architecture.md` "Layer graph and import
rules").

So a full-lifecycle replay that must drive the paper adapter — synthetic
market input through paper dispatch, fill, and settlement — lives beside the
code that owns that adapter instead, as an `*.int.test.ts` under
`apps/trading/src/execution/`, selected by the same root Vitest
`integration` project as everything here; moving it under this directory
would mean teaching `tests/` to import an adapter, which is the one thing
the layer graph forbids. `journal-rebuild.int.test.ts` in this directory
shows the adapter-free shape instead: it drives `@vigil/db` and
`@vigil/ledger` directly through a hand-built journal history, never the
adapter that would have produced one.
