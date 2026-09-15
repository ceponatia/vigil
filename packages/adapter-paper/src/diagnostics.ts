/**
 * diagnostics.ts — why the paper adapter refused a schema-legal request.
 *
 * `docs/resilience.md` §4: schema-legal input never throws; a refusal is
 * data carrying a code. Two vocabularies meet here and stay apart in both
 * type and name, the same separation `packages/ledger/src/diagnostics.ts`
 * makes:
 *
 * - **Policy reason codes** are owned by `docs/policy.md` and extended only
 *   there. This adapter emits two of them, and only where the code's own
 *   definition is an exact fit: `STALE_QUOTE` when the quote backing a
 *   submission fails `@vigil/market`'s freshness gate, and
 *   `TRANSACTION_UNRESOLVED` when an earlier attempt on the same intent is
 *   still unresolved at the venue — "a prior transaction's outcome is still
 *   unknown and blocks new economic action on the same funds" is precisely
 *   what an unreconciled order is.
 * - **Adapter diagnostics** are this package's local execution vocabulary.
 *   They say why a submission, poll, cancellation, or reconciliation could
 *   not be performed. None of them is a policy judgement, and none may be
 *   recorded as one.
 *
 * A refusal is not an order state. Refusing to submit leaves the order
 * exactly where it was — most importantly, it never becomes `REJECTED`,
 * which this lifecycle reserves for a rejection the venue itself confirmed
 * (`docs/architecture.md` "Execution lifecycles").
 */

export const PAPER_ADAPTER_DIAGNOSTIC_CODES = [
  /** The value handed in did not parse against this package's own schema. */
  "MALFORMED_INTENT",
  /** The intent's action is not one this adapter can turn into an order. */
  "NON_EXECUTABLE_ACTION",
  /** The intent names an adapter capability version this build does not implement. */
  "CAPABILITY_VERSION_MISMATCH",
  /** The order quantity is zero or negative; there is nothing to execute. */
  "NON_POSITIVE_QUANTITY",
  /** The intent's validity window had already closed at the supplied time. */
  "INTENT_EXPIRED",
  /** A price or quantity carries finer precision than the venue's declared scale. */
  "VENUE_PRECISION_EXCEEDED",
  /** The quote backing the submission is not usable for a reason other than staleness. */
  "QUOTE_UNUSABLE",
  /** The quote prices a different instrument than the order's own asset pair. */
  "QUOTE_INSTRUMENT_MISMATCH",
  /** The quote's ask is below its bid; a crossed book is corrupt market state. */
  "CROSSED_QUOTE_BOOK",
  /** The order is not in the state this operation may be performed from. */
  "ILLEGAL_TRANSITION",
  /** Submission was asked for from a state other than RESERVED. */
  "ORDER_NOT_RESERVED",
  /** The operation needs a live venue order; this one is not live. */
  "ORDER_NOT_LIVE",
  /** The order already reached a terminal state; nothing further happens to it. */
  "ORDER_ALREADY_TERMINAL",
  /** Worst-case cost at the venue's capped price and fee exceeds the intent's maxSpend. */
  "MAX_SPEND_EXCEEDED",
  /** Worst-case proceeds fall below the intent's minAcceptableReceipt. */
  "RECEIPT_BELOW_MINIMUM",
  /** The venue already holds a terminal order under this idempotency key. */
  "IDEMPOTENCY_KEY_ALREADY_USED",
  /** The order is unresolved; reconciliation must run before anything else does. */
  "RECONCILIATION_REQUIRED",
  /** The order is not awaiting reconciliation, so there is nothing to resolve. */
  "RECONCILIATION_NOT_APPLICABLE",
  /** The reconciliation read did not cover this order, so it stays unresolved. */
  "RECONCILIATION_INCOMPLETE",
  /** The reconciliation read was not one this exchange issued, so it authorizes nothing. */
  "RECONCILIATION_REPORT_UNRECOGNIZED",
  /** The reconciliation read was taken before the dispatch it is being asked to resolve. */
  "RECONCILIATION_READ_PREDATES_DISPATCH",
  /** The venue's confirmed state cannot follow the order's current state. */
  "RECONCILIATION_CONTRADICTION",
  /** The exchange has no record of an order the caller believes is live there. */
  "VENUE_ORDER_NOT_FOUND",
] as const;

export type PaperAdapterDiagnosticCode = (typeof PAPER_ADAPTER_DIAGNOSTIC_CODES)[number];

/**
 * The `docs/policy.md` reason codes this package emits verbatim.
 * Deliberately short: every other refusal it can produce is an execution
 * fact, not a policy decision.
 */
export const PAPER_ADAPTER_POLICY_REASON_CODES = ["STALE_QUOTE", "TRANSACTION_UNRESOLVED"] as const;

export type PaperAdapterPolicyReasonCode = (typeof PAPER_ADAPTER_POLICY_REASON_CODES)[number];

/**
 * A refusal reason tagged with the vocabulary it came from, so neither a
 * caller nor an operator reading a record can mistake a local execution
 * diagnostic for an owner-approved policy code.
 */
export type PaperRefusalReason =
  | { readonly source: "adapter"; readonly code: PaperAdapterDiagnosticCode }
  | { readonly source: "policy"; readonly code: PaperAdapterPolicyReasonCode };

export type PaperRefusal = {
  readonly reason: PaperRefusalReason;
  /** Operator-facing context. Never contains a secret, key, or credential — this package holds none. */
  readonly detail: string;
};

export function adapterRefusal(code: PaperAdapterDiagnosticCode, detail: string): PaperRefusal {
  return { reason: { source: "adapter", code }, detail };
}

export function policyRefusal(code: PaperAdapterPolicyReasonCode, detail: string): PaperRefusal {
  return { reason: { source: "policy", code }, detail };
}
