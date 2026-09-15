import type { ReasonCode } from "@vigil/contracts";
import type { PaperAdapterDiagnosticCode, PaperRefusal } from "@vigil/adapter-paper";
import { isPolicyReason, type PolicyRefusal } from "@vigil/policy";

/**
 * diagnostics.ts — why the execution domain declined to act.
 *
 * Three vocabularies meet on the execution path and each one stays
 * distinguishable in the type, the same split `@vigil/policy` and
 * `@vigil/ledger` already make:
 *
 * - **Policy reason codes** (`docs/policy.md`) are decisions about the
 *   proposal, and the only refusals that may ever be written onto a durable
 *   record as a reason: a row saying an intent was skipped for
 *   `INSUFFICIENT_NET_EDGE` is a claim that policy actually made that
 *   judgement.
 * - **Adapter diagnostics** (`@vigil/adapter-paper`) are execution facts:
 *   the venue could not be asked, or refused to be asked. Kept as the
 *   adapter's own code rather than flattened into a string, so a caller can
 *   switch on `IDEMPOTENCY_KEY_ALREADY_USED` versus `ORDER_NOT_RESERVED`
 *   without parsing prose.
 * - **Execution diagnostics** are this domain's local vocabulary for "the
 *   question could not be asked here": a malformed cost model, a durable
 *   write that refused, an adapter that is not the paper one.
 *
 * None of the last two may be recorded as a policy decision, and
 * `recordableReasonCode` below is the one place that distinction is drawn.
 */

export const EXECUTION_DIAGNOSTIC_CODES = [
  /** The injected venue cost model did not parse: a missing, malformed, or unknown field. */
  "MALFORMED_VENUE_CONFIG",
  /**
   * `@vigil/policy` could not answer — a malformed limit set, a non-positive
   * price, a negative cost component. Never a judgement about the proposal,
   * so never written down as one.
   */
  "POLICY_QUESTION_UNANSWERABLE",
  /** No approved intent exists under this id; nothing authorizes an attempt on it. */
  "UNKNOWN_INTENT",
  /** The intent's action authorizes no execution — a decision to do nothing is never turned into an order. */
  "NON_EXECUTABLE_ACTION",
  /**
   * An earlier attempt on this authorization is still unresolved, so no
   * further attempt may be opened. **Reconcile, then retry** — distinct from
   * `INTENT_ALREADY_CONSUMED`, whose answer is never to retry at all.
   */
  "ATTEMPT_ALREADY_LIVE",
  /**
   * An earlier attempt already spent against this authorization. **Never
   * retry**: a remainder is a new authorization, not a further attempt.
   */
  "INTENT_ALREADY_CONSUMED",
  /**
   * The authorization routes over a chain. The Exchange attempt lifecycle
   * cannot describe a broadcast and the `transactions` record family is not
   * built, so this is refused before any capital is held.
   */
  "CHAIN_LIFECYCLE_UNSUPPORTED",
  /**
   * A settlement disagrees with what durable history already confirmed about
   * the same attempt. Never an edit: confirmed money does not move backwards,
   * and a reconciliation that contradicts a settled attempt is an incident to
   * record rather than a write to force.
   */
  "SETTLEMENT_CONTRADICTS_HISTORY",
  /**
   * The action is an exit. Authorizing one needs a position basis and
   * realized-P&L accounting this build does not have, and inventing them
   * would put an unverified basis calculation on the money path. This slice
   * authorizes entry actions only.
   */
  "EXIT_PATH_NOT_BUILT",
  /**
   * The adapter wired in is not a PAPER adapter that reaches no endpoint,
   * holds no credential, and cannot sign. This build dispatches to nothing
   * else (`docs/policy.md` "Operating modes"; LIVE sits behind a capability
   * gate no code here can open).
   */
  "ADAPTER_NOT_PAPER",
  /** The intent was approved in an operating mode this build will not dispatch in. */
  "OPERATING_MODE_NOT_PAPER",
  /** The quote prices a different instrument than the intent's own asset pair. */
  "QUOTE_INSTRUMENT_MISMATCH",
  /** A price or amount carries finer precision than the venue's declared scale. */
  "VENUE_PRECISION_EXCEEDED",
  /** The quote's ask is below its bid; a crossed book is corrupt market state. */
  "CROSSED_QUOTE_BOOK",
  /**
   * A durable record could not be written, so no economic action proceeds
   * (`docs/resilience.md` §9). A write failure is a reason to stop, never a
   * reason to act from memory and reconcile later.
   */
  "PERSISTENCE_REFUSED",
  /** Capital could not be held for this authorization, so nothing may be dispatched against it. */
  "RESERVATION_REFUSED",
  /** The attempt or its dispatch row is not in the state this operation needs. */
  "ATTEMPT_NOT_DISPATCHABLE",
  /** The venue refused the operation for an execution reason of its own. */
  "ADAPTER_REFUSED",
  /**
   * A confirmed spend exceeded the authorization's own ceiling. The overspend
   * has already happened at the venue, so it is surfaced rather than refused
   * — refusing to persist it would blind the application to real exposure.
   */
  "OVERSPEND_CONFIRMED",
] as const;

export type ExecutionDiagnosticCode = (typeof EXECUTION_DIAGNOSTIC_CODES)[number];

export type ExecutionRefusalReason =
  | { readonly source: "policy"; readonly code: ReasonCode }
  | { readonly source: "adapter"; readonly code: PaperAdapterDiagnosticCode }
  | { readonly source: "execution"; readonly code: ExecutionDiagnosticCode };

export type ExecutionRefusal = {
  readonly reason: ExecutionRefusalReason;
  /**
   * Operator-facing context. Never a secret, key, or credential — this
   * runtime holds none today — but **not safe to log verbatim**: several
   * refusals embed balance-like amounts so a reader can follow the
   * arithmetic, and `docs/resilience.md` §10 bars a personal balance from a
   * structured log line. Persist it on the record and render it behind
   * authentication; log the code and the correlation id.
   */
  readonly detail: string;
};

export function executionRefusal(code: ExecutionDiagnosticCode, detail: string): ExecutionRefusal {
  return { reason: { source: "execution", code }, detail };
}

export function policyBlock(code: ReasonCode, detail: string): ExecutionRefusal {
  return { reason: { source: "policy", code }, detail };
}

/** Translates a `@vigil/policy` refusal, preserving its two-vocabulary split. */
export function fromPolicyRefusal(refusal: PolicyRefusal): ExecutionRefusal {
  if (isPolicyReason(refusal.reason)) {
    return policyBlock(refusal.reason.code, refusal.detail);
  }
  return executionRefusal(
    "POLICY_QUESTION_UNANSWERABLE",
    `policy could not answer (${refusal.reason.code}): ${refusal.detail}`,
  );
}

/** Translates a `@vigil/adapter-paper` refusal, preserving its two-vocabulary split. */
export function fromAdapterRefusal(refusal: PaperRefusal): ExecutionRefusal {
  if (refusal.reason.source === "policy") {
    return policyBlock(refusal.reason.code, refusal.detail);
  }
  return { reason: { source: "adapter", code: refusal.reason.code }, detail: refusal.detail };
}

/**
 * The `docs/policy.md` code this refusal may be recorded under, or `null`
 * when it is not a policy decision at all.
 *
 * The null branch is the load-bearing one: giving a configuration bug or an
 * adapter fault the nearest plausible policy code would put a decision policy
 * never made into the record an operator reads.
 */
export function recordableReasonCode(refusal: ExecutionRefusal): ReasonCode | null {
  return refusal.reason.source === "policy" ? refusal.reason.code : null;
}
