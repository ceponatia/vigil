/**
 * Why the ledger refused a schema-legal request.
 *
 * `docs/resilience.md` §4: schema-legal input never throws — a refusal is
 * data carrying a code, not a stack trace. Two vocabularies meet here and
 * are deliberately kept apart in both type and name:
 *
 * - **Policy reason codes** are owned by `docs/policy.md` and extended only
 *   there. The ledger emits exactly one of them, `YIELD_LOCKED`, because the
 *   question "are these funds locked?" is a policy-visible answer an operator
 *   already has vocabulary for.
 * - **Ledger diagnostics** are this package's local accounting vocabulary.
 *   They describe why an arithmetic or bookkeeping operation could not be
 *   performed, which is not a policy judgement. `INSUFFICIENT_AVAILABLE` is
 *   the plain-overspend case and is NOT a policy reason code: nothing about
 *   the request breached a limit, there simply was not enough unreserved
 *   balance.
 *
 * Seam: once `packages/contracts` owns the reason-code registry, the
 * `"policy"` half of `RefusalReason` should be typed by that registry rather
 * than by the local literal below, and this vocabulary should be reported to
 * the owner as a candidate `docs/policy.md` extension.
 */

export const LEDGER_DIAGNOSTIC_CODES = [
  /** The request asked for more base units than the available balance holds. */
  "INSUFFICIENT_AVAILABLE",
  /** The request targets a holdings state that is not a reservation source. */
  "STATE_NOT_RESERVABLE",
  /** Debits and credits do not match for at least one asset in the entry. */
  "UNBALANCED_ENTRY",
  /** One asset appeared with two different scales. */
  "SCALE_MISMATCH",
  /** The decimal amount carries more precision than the asset's scale holds. */
  "UNREPRESENTABLE_PRECISION",
  /** The supplied scale is outside the representable range. */
  "SCALE_OUT_OF_RANGE",
  /** A posted amount was zero or negative; direction carries the sign. */
  "NON_POSITIVE_AMOUNT",
  /** The entry's kind may not touch one of the account families it posts to. */
  "ENTRY_KIND_ACCOUNT_MISMATCH",
  /** The value did not parse against the ledger's own schema. */
  "MALFORMED_ENTRY",
  /** An entry with this id is already posted; the journal is append-only. */
  "DUPLICATE_ENTRY_ID",
  /** An entry with this idempotency key is already posted. */
  "DUPLICATE_IDEMPOTENCY_KEY",
  /** The target entry is already reversed; reversing twice double-counts. */
  "DUPLICATE_REVERSAL",
  /** The reversal names an entry that is not in the journal. */
  "UNKNOWN_REVERSAL_TARGET",
  /** The reservation's expiry is not strictly after the event it reserves for. */
  "INVALID_RESERVATION_WINDOW",
  /** The release asks for more base units than the reservation still holds. */
  "RELEASE_EXCEEDS_RESERVED",
] as const;

export type LedgerDiagnosticCode = (typeof LEDGER_DIAGNOSTIC_CODES)[number];

/**
 * The policy reason codes this package emits verbatim (`docs/policy.md`
 * "Reason codes"). Deliberately a one-element list: every other refusal the
 * ledger can produce is an accounting fact, not a policy decision.
 */
export const LEDGER_EMITTED_POLICY_REASON_CODES = ["YIELD_LOCKED"] as const;

export type LedgerEmittedPolicyReasonCode = (typeof LEDGER_EMITTED_POLICY_REASON_CODES)[number];

/**
 * A refusal reason, tagged with the vocabulary it comes from so a caller
 * (and an operator reading a record) can never mistake a local accounting
 * diagnostic for an owner-approved policy code.
 */
export type RefusalReason =
  | { readonly source: "ledger"; readonly code: LedgerDiagnosticCode }
  | { readonly source: "policy"; readonly code: LedgerEmittedPolicyReasonCode };

export type LedgerRefusal = {
  readonly reason: RefusalReason;
  /** Operator-facing context. Never contains a secret, key, or credential. */
  readonly detail: string;
};

export function ledgerRefusal(code: LedgerDiagnosticCode, detail: string): LedgerRefusal {
  return { reason: { source: "ledger", code }, detail };
}

export function policyRefusal(code: LedgerEmittedPolicyReasonCode, detail: string): LedgerRefusal {
  return { reason: { source: "policy", code }, detail };
}
