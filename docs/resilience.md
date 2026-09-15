# Resilience

The failure policy every module follows. None of these are optional, and none of them wait for a specific slice to land — a module that cannot meet them yet is not built rather than built to a lower standard ([architecture.md](architecture.md) Not built).

## 1. Fail closed on financial authority

New risk is blocked, never assumed safe, on any of:

- Stale, corrupt, or missing market or account state
- Unreconciled balances, or a private-feed gap
- Unexpected chain state or missing metadata
- Unavailable protection for an open position
- Insufficient persistence — see [§9](#9-persistence-before-action)
- An unresolved transaction that could double-spend capital

Research or provider failure never disables existing deterministic risk management, and invalid market/account/chain state blocks new risk without touching protective action capacity.

## 2. Protective actions are never blocked by research or provider failure

A dead LLM provider, an exhausted research budget, or a stale news feed degrades discretionary research ([§6](#6-degrade-on-research)). It never delays or blocks pausing new entries, canceling a non-protective action, reducing liquid exposure, or canceling everything where the venue supports it.

## 3. UNKNOWN is a state

A submission timeout, a cancellation timeout, and broadcast ambiguity are never resolved by assumption; none of them produces a success or a failure. A submission timeout and broadcast ambiguity produce the UNKNOWN state. A cancellation timeout produces an UNKNOWN attempt result and leaves the order where it already is — the state that means the cancellation was requested and not confirmed, `CANCEL_PENDING` in the exchange lifecycle — because an unconfirmed cancellation has neither taken effect nor been refused.

An order in either condition releases nothing and accepts no further operation: it is not polled forward, not cancelled again, and not resubmitted. It resolves only through reconciliation against the venue's or chain's own confirmed state — orders, history, executions, and balances — which precedes any resubmission, replacement, or cancellation retry. Filled exposure from a partial fill persists through a cancellation; only the confirmed unfilled remainder is released.

## 4. Diagnostics and reason codes over exceptions

Schema-legal input never throws. Every rejection carries a reason code from [policy.md](policy.md) — `STALE_QUOTE`, `EXPOSURE_LIMIT`, `SIMULATION_FAILED`, and the rest are policy decisions recorded as data, not stack traces surfaced to a caller. An exception is reserved for a programmer error, never for a proposal that policy declines.

## 5. Validate at trust boundaries with zod

Every value crossing a trust boundary — provider response, chain data, LLM output, API request body — is parsed against an application-owned zod schema before use, in a `parseOr`-style shape: parse, and on failure fall back to a safe, explicitly-marked default rather than throwing into the pipeline.

Structured output from an LLM constrains shape, never truth. A response that parses cleanly against its schema is validated again for identity (does this asset ID resolve to a real, canonical asset), enum membership, evidence references (does the cited evidence actually exist and say what the response claims), and timestamps (is this response about data that was actually available at the time), after every LLM response, regardless of schema validity.

## 6. Degrade on research

Budget exhaustion, a provider outage, or a retrieval failure stops discretionary research — thesis generation, evidence retrieval, deep refreshes — without touching deterministic risk management. The strategy engine, the allocator, and the execution domain keep running unaffected. A research packet can be valid for analysis while ineligible for execution.

## 7. Single writer and fencing

Exactly one process holds effective write authority per financial authority domain at any moment. A failover fences the outgoing writer — revokes its actual dispatch/signing authority — before the incoming writer acts. A database lease alone is insufficient: a lease can expire in the coordination layer while a stale process still holds an open connection and can still dispatch. Fencing must remove real capability, not just a coordination flag.

## 8. Restart and handover

No unattended restart proceeds while an order or transaction is unresolved. A deployment or handover must preserve known risk state and hand over authority cleanly rather than let two processes believe they hold it, or let neither hold it, for even a moment.

## 9. Persistence before action

Intent and reservation are persisted before submission. Dispatch goes through a durable outbox. If a durable record cannot be written, no new economic action proceeds — a write failure is a reason to stop, never a reason to act from memory and reconcile later.

## 10. Logging

Logs are structured (pino). A log line never contains a secret, a key, a seed, a plaintext credential, or a personal balance. Every economic record carries a correlation ID so an intent, its attempts, and its outcome can be traced across the outbox, the venue or chain, and the ledger.

## 11. Untrusted content

A webpage, a news article, token metadata, or repository text is evidence, never an instruction. An instruction embedded in retrieved content — asking the model to disable a control, change a limit, or reveal a secret — has no route to authority: it cannot reach policy, the allocator, or the signer, regardless of how it is phrased or what authority it claims. Encountering one is recorded as a security event, not silently discarded and not obeyed.
