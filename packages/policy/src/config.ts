import { z } from "zod";
import { decimalStringSchema } from "@vigil/contracts";

import { inputRefusal, type PolicyRefusal } from "./diagnostics";
import { isNegative, isPositive } from "./scaled-decimal";

/**
 * config.ts — the injected limit set, and the guard that refuses a
 * malformed one.
 *
 * `docs/policy.md` "Numerical controls" is explicit that its table is
 * "carried over from planning discussion ... not an approved policy, must
 * not be deployed as configuration". So this module supplies **no
 * default for any limit**. Every field below is required, and
 * `parsePolicyConfig` is the trust boundary (`docs/resilience.md` §5) that
 * a caller must pass before any check in this package will look at a
 * proposal.
 *
 * The failure this design exists to prevent is a silent one: a limit that
 * is absent, misspelled, or nonsensical must stop new risk
 * (`docs/resilience.md` §1), never fall back to a permissive value that
 * nobody approved. Three specific guards carry that weight:
 *
 * - **No defaults, no optionals.** A missing `minimumQuantity` cannot
 *   become `0`, which would make every size clear the minimum.
 * - **`z.strictObject`.** An unknown key is a refusal, not ignored input. A
 *   typo'd `minimumNotional` (missing the `Quote` suffix) would otherwise
 *   leave the real field missing *and* the typo silently discarded.
 * - **Sign constraints beyond the decimal shape.** `decimalStringSchema`
 *   accepts `"-1"`. A negative `minimumNetEdgeQuote` would let a proposal
 *   with negative expected edge clear its threshold; a non-positive
 *   `minimumQuantity` or `minimumNotionalQuote` would disable the
 *   `MINIMUM_NOTIONAL` skip entirely. Each is a fail-open configuration and
 *   each is refused here.
 */

/**
 * The largest venue quantity precision this package will accept. Matches
 * the bound `packages/ledger/src/base-units.ts` documents for asset scale
 * (an 18-decimal token squared still fits, and no real asset exceeds it);
 * restated here rather than imported, because `policy` may not depend on
 * `ledger` (`docs/architecture.md` "Layer graph and import rules").
 *
 * This is a representational bound, not an owner risk limit — it caps how
 * many digits the arithmetic walks, and approves nothing.
 */
export const MAX_QUANTITY_SCALE = 36;

const nonNegativeDecimalSchema = decimalStringSchema.refine((value) => !isNegative(value), {
  error: "must be zero or greater",
});

const positiveDecimalSchema = decimalStringSchema.refine((value) => isPositive(value), {
  error: "must be strictly greater than zero",
});

/**
 * A duration threshold in milliseconds. `.int()` rejects `NaN` and
 * `Infinity` as well as fractional values, so an unusable threshold can
 * never be read as "everything passes" — `packages/market/src/freshness.ts`
 * takes the same position on a corrupt threshold.
 */
const thresholdMsSchema = z.number().int().min(0);

export const policyConfigSchema = z.strictObject({
  /** A quote strictly older than this is `STALE_QUOTE`. The boundary itself is still fresh. */
  maxQuoteAgeMs: thresholdMsSchema,
  /** Reconciliation completed longer ago than this is `ACCOUNT_UNRECONCILED`. */
  maxReconciliationAgeMs: thresholdMsSchema,
  /** Net edge, in quote currency, that a sized trade must reach. Zero or greater; never negative. */
  minimumNetEdgeQuote: nonNegativeDecimalSchema,
  /** The venue's supported quantity precision, in fractional digits. Sizes round DOWN to it. */
  quantityScale: z.number().int().min(0).max(MAX_QUANTITY_SCALE),
  /** The venue's or policy's minimum tradable quantity. Below it is a `MINIMUM_NOTIONAL` skip. */
  minimumQuantity: positiveDecimalSchema,
  /** The notional below which a trade is not economically meaningful. Also a `MINIMUM_NOTIONAL` skip. */
  minimumNotionalQuote: positiveDecimalSchema,
});

/**
 * A validated limit set. The only way to hold one is to have parsed it
 * through `parsePolicyConfig`, so no check in this package can be handed a
 * hand-built object literal that skipped the guards above.
 */
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export type PolicyConfigResult =
  | { readonly outcome: "ok"; readonly config: PolicyConfig }
  | { readonly outcome: "refused"; readonly refusal: PolicyRefusal };

/**
 * Parses an untrusted limit set. Never throws, on any input
 * (`docs/resilience.md` §4, §5) — a malformed set comes back as a
 * `MALFORMED_POLICY_CONFIG` diagnostic naming the offending fields, the way
 * `evaluateQuoteFreshness` names the fields of a rejected quote.
 */
export function parsePolicyConfig(raw: unknown): PolicyConfigResult {
  const parsed = policyConfigSchema.safeParse(raw);
  if (parsed.success) {
    return { outcome: "ok", config: parsed.data };
  }
  return { outcome: "refused", refusal: inputRefusal("MALFORMED_POLICY_CONFIG", describeIssues(parsed.error)) };
}

/**
 * Field-level context for a rejected object, without echoing the values
 * themselves — a limit set is not secret, but the habit of not reflecting
 * parsed input back into a message is worth keeping uniform.
 */
export function describeIssues(error: z.ZodError): string {
  const described = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return `did not parse (${[...new Set(described)].join("; ")})`;
}

/**
 * Picks the right diagnostic for a rejected params object: a problem inside
 * the embedded `config` is a limit-set problem, anything else is a caller
 * problem. Every check in this package re-parses the `PolicyConfig` it is
 * handed, because `PolicyConfig` is a plain inferred type — a caller can
 * still reach one with a cast, and a cast-in limit set must not be trusted
 * any further than a parsed one.
 */
export function refusalForParseError(error: z.ZodError): PolicyRefusal {
  const touchesConfig = error.issues.some((issue) => issue.path[0] === "config");
  const code = touchesConfig ? "MALFORMED_POLICY_CONFIG" : "MALFORMED_INPUT";
  return inputRefusal(code, describeIssues(error));
}
