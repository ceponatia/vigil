import type { ReasonCode } from "@vigil/contracts";

/**
 * diagnostics.ts — why this package declined a schema-legal request.
 *
 * `docs/resilience.md` §4: schema-legal input never throws — a refusal is
 * data carrying a code, not a stack trace. Two vocabularies meet here and
 * are kept apart in both type and name, the same split
 * `packages/ledger/src/diagnostics.ts` already establishes:
 *
 * - **Policy reason codes** are owned by `docs/policy.md` and extended only
 *   there. `POLICY_EMITTED_REASON_CODES` below names the six this package
 *   can emit, so a reader can tell this package's vocabulary from the full
 *   twenty without grepping. This slice adds no code to the registry;
 *   extending it means editing `docs/policy.md` first.
 * - **Policy input diagnostics** are this package's local vocabulary for
 *   "the question could not be asked", which is never a policy judgement
 *   about a proposal. A malformed limit set, a non-positive price, or a
 *   negative cost component is a configuration or caller bug; answering it
 *   with, say, `EXPOSURE_LIMIT` would put a fabricated policy decision into
 *   the opportunity journal.
 *
 * Every diagnostic below is a *refusal*, never a fallback value. The
 * failure mode this guards is `docs/resilience.md` §1's: an unanswerable
 * question must block new risk, not resolve to a permissive default.
 */

/**
 * The policy reason codes this package emits verbatim (`docs/policy.md`
 * "Reason codes").
 *
 * `satisfies readonly ReasonCode[]` is load-bearing: it makes every member
 * provably a `packages/contracts` `REASON_CODES` registry member at compile
 * time, so a typo or an invented code is a type error here rather than a
 * string that reaches a record and looks official.
 */
export const POLICY_EMITTED_REASON_CODES = [
  /** The quote backing the decision is older than its injected freshness threshold. */
  "STALE_QUOTE",
  /** The executable price has moved outside the proposal's approved entry zone. */
  "OUTSIDE_ENTRY_ZONE",
  /** The sized trade falls below the injected venue/policy minimum. A skip, never a round-up. */
  "MINIMUM_NOTIONAL",
  /** Expected advantage after every supplied fee, spread and cost does not clear the injected threshold. */
  "INSUFFICIENT_NET_EDGE",
  /** The action would breach a supplied single-asset, sector, or portfolio cap. */
  "EXPOSURE_LIMIT",
  /** Balances have not been reconciled recently enough, or carry an unresolved discrepancy. */
  "ACCOUNT_UNRECONCILED",
] as const satisfies readonly ReasonCode[];

export type PolicyEmittedReasonCode = (typeof POLICY_EMITTED_REASON_CODES)[number];

/**
 * This package's local vocabulary for an input or configuration that makes
 * the policy question unanswerable. Not policy codes, and deliberately not
 * spelled like one: none of these may be recorded as a policy decision
 * about the proposal.
 */
export const POLICY_DIAGNOSTIC_CODES = [
  /** The injected limit set did not parse: a missing, malformed, or unknown limit. */
  "MALFORMED_POLICY_CONFIG",
  /** A check's own parameters did not parse against this package's schema. */
  "MALFORMED_INPUT",
  /** The executable price was zero or negative, so no notional or quantity is derivable from it. */
  "NON_POSITIVE_PRICE",
  /** The adverse-loss stop distance was zero or negative, so the loss budget bounds no size at all. */
  "NON_POSITIVE_STOP_DISTANCE",
  /**
   * Exposure headroom reached sizing at zero. `checkExposure` refuses a
   * cap with no headroom before it ever returns one, so a zero here means
   * the exposure gate was skipped — a caller bug, not a cap decision.
   */
  "NON_POSITIVE_EXPOSURE_HEADROOM",
  /** A cost component was negative. A negative "cost" is a rebate that would inflate net edge past its threshold. */
  "NEGATIVE_COST_COMPONENT",
  /** A sizing bound was negative. The minimum of a set containing a negative is not a tradable size. */
  "NEGATIVE_SIZE_BOUND",
  /** No exposure cap was supplied. Sizing against an empty cap set is sizing against no limit at all. */
  "NO_EXPOSURE_CAP",
  /** Two timestamps did not resolve to an elapsed duration, so freshness or reconciliation age is unknown. */
  "UNCOMPUTABLE_AGE",
] as const;

export type PolicyDiagnosticCode = (typeof POLICY_DIAGNOSTIC_CODES)[number];

/**
 * A refusal reason, tagged with the vocabulary it comes from so a caller —
 * and an operator reading an opportunity-journal row — can never mistake a
 * local input diagnostic for an owner-approved policy code.
 */
export type RefusalReason =
  | { readonly source: "policy"; readonly code: PolicyEmittedReasonCode }
  | { readonly source: "input"; readonly code: PolicyDiagnosticCode };

export type PolicyRefusal = {
  readonly reason: RefusalReason;
  /**
   * Operator-facing context, for the opportunity journal and the
   * authenticated control UI. Never contains a secret, key, seed, or
   * credential.
   *
   * It is **not safe to log verbatim.** Several refusals deliberately
   * embed balance-like amounts so a reader can see the arithmetic:
   * `checkExposure` names the current exposure and the cap it was measured
   * against, and `sizeTrade` names funds available, sized quantities, and
   * notionals. `docs/resilience.md` §10 bars a personal balance from a
   * structured log line. Persist this on the record and render it behind
   * authentication; log the reason code and the correlation ID instead of
   * piping `detail` into a `pino` line.
   */
  readonly detail: string;
};

/** A policy decision about the proposal, carrying a `docs/policy.md` reason code. */
export function policyRefusal(code: PolicyEmittedReasonCode, detail: string): PolicyRefusal {
  return { reason: { source: "policy", code }, detail };
}

/** An input or configuration problem that makes the policy question unanswerable. */
export function inputRefusal(code: PolicyDiagnosticCode, detail: string): PolicyRefusal {
  return { reason: { source: "input", code }, detail };
}

/** Narrowing helper: true when this refusal is an owner-vocabulary policy decision rather than a local input diagnostic. */
export function isPolicyReason(
  reason: RefusalReason,
): reason is { readonly source: "policy"; readonly code: PolicyEmittedReasonCode } {
  return reason.source === "policy";
}
