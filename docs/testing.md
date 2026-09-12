# Testing

## Test layers

| Layer                | Selection                                    | IO                          |
| ----------------------- | ----------------------------------------------- | ------------------------------ |
| Unit                    | `*.test.ts`, co-located with source, root Vitest project `unit` | None — pure functions only     |
| Integration             | `*.int.test.ts`, root Vitest project `integration` | Postgres                       |
| Replay                  | `tests/replay/`                                 | Deterministic full-lifecycle replays against recorded or synthetic fixtures |
| Fault injection         | `tests/fault-injection/`                        | The scenario matrix below, exercised against fake adapters/providers |
| Fixtures                | `tests/fixtures/`                               | Synthetic only — no personal holdings, no real addresses, no keys |

## CI mapping

CI job names are fixed: `classify changes`, `lint`, `static checks`, `unit tests`, `integration`, `verify`.

| Job                | Runs                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `classify changes`  | Classifies changed paths into docs-only, code, and integration-affecting; gates every other job |
| `lint`               | `pnpm lint` — type-aware ESLint, including the layer-graph zone rules                         |
| `static checks`      | `pnpm lint:cycles` (madge), `pnpm typecheck`, `pnpm jscpd`                                     |
| `unit tests`         | `pnpm test` — every unit-layer suite across `apps/` and `packages/`                            |
| `integration`        | Postgres via Docker Compose, `pnpm db:migrate` from zero, then `pnpm test:int`                 |
| `verify`             | Aggregate: requires every applicable job to succeed and every inapplicable job to be skipped or successful |

A draft pull request runs nothing. A ready pull request runs the jobs its changed paths make applicable. A green `verify` proves only that the applicable jobs ran and passed — it does not claim an inapplicable job, or a test file outside a job's selection, ran.

## Local execution boundary

No local gates run on the development machine: not `pnpm test`, not `pnpm test:int`, not `pnpm lint`, not `pnpm typecheck`, not `pnpm build`, not any direct or watch-mode Vitest invocation. CI is the gate. The repository's preflight hook enforces this by refusing the command locally rather than relying on discipline alone.

Two exceptions exist:

- Dependency-free offline fixture tests for skill and hook helpers (Python `unittest`, bash with a mocked `gh`) may run locally, because they start no application service and touch no database.
- `pnpm lint:docs`, once it exists, may run locally, for the same reason.

## Admission rules

From the `vigil-testing` skill:

- Name the invariant and a realistic bad implementation before writing the test. A test that cannot describe what wrong behavior it would catch is not ready to write.
- Place a claim at the lowest layer that owns it. A pure eligibility check belongs in `packages/policy` unit tests, not in an integration suite that happens to exercise it indirectly.
- Use fake adapters and fake providers, never fetch-layer mocks. A fake adapter implements the same interface the real one will and returns programmed venue/chain behavior; a fetch mock only hides the HTTP boundary and proves nothing about the adapter's contract.
- A degradation test asserts both the fallback behavior and the reason code or diagnostic it produces — never the fallback alone.
- A literal value is pinned only where the literal is the contract: wire formats, hashes, allowlists, and migrations. Everything else is derived from the schema or registry it comes from.

## Acceptance and fault-injection matrix

A scenario below is reported as **simulated**, **replayed**, **integration-tested**, or **live-verified** — never merely "listed". Layer values are `unit`, `integration`, `replay`, `fault-injection`, or `live canary`.

### Entry discipline

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Attractive historical low; current executable price outside the approved entry zone | WAIT/MISSED; no late chasing trade                | unit  |

### Idempotency and recovery

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Same proposal or job delivered twice                                          | At most one economic intent/tranche                | integration |
| Crash after exchange acceptance but before local acknowledgement              | UNKNOWN then reconciliation; no blind duplicate    | fault-injection |
| Partial exchange fill followed by cancellation                                | Filled exposure and fees persist; only confirmed unfilled remainder released | fault-injection |

### Capital and reservations

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Two strategies try to spend the same funds                                    | Atomic reservation permits only feasible aggregate spending | integration |
| Sell/trim and protection contend for the same inventory                       | Coordinated state; no unintended double-sell or silently missing protection | fault-injection |
| Non-atomic arbitrage leg fails or times out                                   | Recover from actual fills with bounded residual risk; surface unresolved state | fault-injection |
| Drawdown pause followed by a deposit                                          | Deposit is not profit and does not silently clear the pause | unit |
| Counterfactual trades reuse the same capital simultaneously                   | Alternatives constrained by a shared capital/time budget | replay |

### Data validity

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Quote/book is stale or corrupt                                                | New risk blocked; recover/reload valid state       | unit  |
| Private feed or wallet state is stale, or an unexplained balance delta appears | Reconcile before increasing exposure               | integration |
| Historical feature includes later-published information                       | Reject contaminated dataset/evaluation             | unit  |
| Chain/contract/mint differs despite a matching ticker                         | Reject wrong asset/network; no symbol-only routing | unit  |

### LLM and security

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| LLM returns invalid JSON, an unknown token, or nonexistent evidence            | Reject proposal; no guessed replacement asset      | unit  |
| Retrieved content instructs the model to disable policy or reveal secrets     | No authority change or secret access; security event recorded | unit |
| Parallel model calls approach the budget ceiling                              | Cost reservations enforce the cap; deterministic risk actions continue | integration |

### Economics and sizing

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Actual exchange/pool/platform fees exceed the research assumption             | Use current verified costs; reject an uneconomic route | unit |
| Proposed size falls below minimum or economic viability                       | Skip; never size up beyond the risk limit          | unit  |
| Profitable experiment lacks mature prospective evidence                       | No automatic full-capital promotion                | replay |

### Yield

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Estimated unbonding date passes but the venue/chain still reports the position locked | Funds remain unavailable                    | live canary |

### On-chain

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Quote transaction changes recipient or includes disallowed nested calls       | Signing policy rejects the actual payload          | unit  |
| Requested allowance is unlimited or for the wrong spender                     | Reject unless an exact, separately approved policy supports it | unit |
| Gas/priority fee exceeds the cap or consumes the recovery reserve             | Reject new risk; do not exhaust protective-action capacity | integration |
| Simulation fails or cannot validate required effects                          | No signing/broadcast for that action               | unit  |
| Broadcast times out                                                            | UNKNOWN/pending reconciliation before another economic attempt | fault-injection |
| Transaction replaced, expires, or is reorganized                              | Selected chain's verified lifecycle and accounting apply; no double execution | fault-injection |
| Transaction fails/reverts but incurs costs                                    | Record network fees/losses without inventing a successful trade | fault-injection |
| Funds exist on another chain but not at the execution location                | Not treated as immediately spendable inventory     | integration |

### Operations

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Product exists in the UI but has no supported API                             | Remain research/manual-only; no undocumented endpoint or browser workaround | unit |
| User makes manual order/funding changes                                       | Reconcile; respect the explicit asset mandate; do not seize unrelated holdings | integration |
| Primary and standby both run                                                   | Only the current fenced authority can dispatch/sign | fault-injection |
| Global cancellation requested on an adapter with a venue-specific cancel-all timer | Protective-order impact made explicit; never described as liquidation | live canary |
| App goes offline while relying on a local exit condition                      | Protection limitation is visible and matches approved risk policy | fault-injection |
| Bridge/on-ramp/issuer route becomes unsupported                               | Disable affected new routes; alert; no improvised unapproved transfer path | integration |

### Privacy

| Scenario                                                                  | Required result                              | Layer |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Private holdings, secrets, or planning notes appear in fixtures or logs       | Fail privacy/security checks and remove before commit/publication | unit |
