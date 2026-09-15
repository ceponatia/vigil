import { decimalStringSchema } from "@vigil/contracts";
import { z } from "zod";

import { executionRefusal, type ExecutionRefusal } from "./diagnostics";

/**
 * venue.ts — the venue's economics, as injected configuration.
 *
 * Every number here is an owner/operator input with **no default**, for the
 * reason `@vigil/policy`'s `parsePolicyConfig` supplies none: a fee rate, a
 * slippage cap, or a fixed cost that is absent, misspelled, or nonsensical
 * must stop new risk (`docs/resilience.md` §1), never fall back to something
 * permissive that nobody approved. `z.strictObject` makes an unknown key a
 * refusal rather than silently-discarded input, so a typo'd
 * `feeBasisPoint` leaves the real field missing *and* is reported.
 *
 * The scales are venue-wide rather than per-instrument, exactly as
 * `PaperExchangeConfig` models them: this build wires one exchange at one
 * money/quantity precision, and the quote asset's registered ledger scale
 * must equal `moneyScale` (checked where an intent is built, because that is
 * where the asset is known).
 *
 * The bounds below are the adapter's own, restated rather than imported
 * because `@vigil/adapter-paper` exports them as constructor validation and
 * not as values. A configuration this parser accepts and
 * `createPaperExchange` would throw on is the failure this alignment exists
 * to prevent — a throw out of a constructor is not a diagnostic anyone can
 * act on.
 */

const nonBlank = z.string().refine((value) => value.trim().length > 0, {
  error: "must not be blank",
});

/**
 * A non-negative decimal amount. `decimalStringSchema` accepts `"-1"` — a
 * negative amount is legitimate elsewhere — and a negative fixed cost would
 * *raise* net edge and *enlarge* every sizing bound, so the sign is refused
 * here. `startsWith("-")` decides it from the string: the base pattern has
 * already rejected anything that is not a decimal, and in zod 4 a refine
 * still runs after that rejection, so this predicate must be total over
 * `string` rather than assume a number.
 */
const nonNegativeDecimal = decimalStringSchema.refine((value) => !value.startsWith("-"), {
  error: "must be zero or greater",
});

export const venueExecutionConfigSchema = z.strictObject({
  /** The venue this configuration prices. Recorded on every intent and attempt. */
  venueId: nonBlank,
  /**
   * The adapter capability an intent approved under this configuration is
   * stamped with. The adapter refuses an intent naming a version it does not
   * implement, so a mismatch here is a refusal at propose time rather than an
   * execution under assumptions the approval never made.
   */
  adapterCapabilityVersion: nonBlank,
  /** Decimal places the venue quotes and settles money in. Must equal the quote asset's ledger scale. */
  moneyScale: z.number().int().min(0).max(18),
  /** Decimal places the venue accepts a quantity in. Must equal the base asset's ledger scale. */
  quantityScale: z.number().int().min(0).max(18),
  /** Venue fee, in basis points of the notional at the execution price. */
  feeBasisPoints: z.number().int().min(0).max(10_000),
  /**
   * The worst price movement against this application the venue will apply,
   * in basis points. Strictly under 10 000: a 100% adverse move would drive a
   * sell's execution price to zero, which is not slippage but a different
   * failure.
   */
  slippageBasisPoints: z.number().int().min(0).max(9_999),
  /** A flat cost charged once per order that actually produced a fill. Zero is valid; absent is not. */
  fixedExecutionCostQuote: nonNegativeDecimal,
  /** The venue-economics version that priced the costs; stored on every intent. */
  costModelVersion: nonBlank,
  /** The fee snapshot these rates came from; stored on every intent as its `feeSnapshotVersion`. */
  feeSnapshotVersion: nonBlank,
});

/**
 * A validated venue cost model. The only way to hold one is to have parsed
 * it, so nothing downstream can be handed a hand-built literal that skipped
 * the guards above.
 */
export type VenueExecutionConfig = z.infer<typeof venueExecutionConfigSchema>;

export type VenueExecutionConfigResult =
  | { readonly outcome: "ok"; readonly venue: VenueExecutionConfig }
  | { readonly outcome: "refused"; readonly refusal: ExecutionRefusal };

/**
 * Parses an untrusted venue cost model. Never throws, on any input
 * (`docs/resilience.md` §4, §5): a malformed model comes back as a
 * `MALFORMED_VENUE_CONFIG` diagnostic naming the offending fields, without
 * echoing their values back.
 */
export function parseVenueExecutionConfig(raw: unknown): VenueExecutionConfigResult {
  const parsed = venueExecutionConfigSchema.safeParse(raw);
  if (parsed.success) {
    return { outcome: "ok", venue: parsed.data };
  }

  const described = parsed.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return {
    outcome: "refused",
    refusal: executionRefusal(
      "MALFORMED_VENUE_CONFIG",
      `the venue cost model did not parse (${[...new Set(described)].join("; ")})`,
    ),
  };
}
