import { z } from "zod";
import { decimalStringSchema, quoteTimestampsSchema } from "@vigil/contracts";

import { instrumentIdSchema } from "./instrument-identity";

/**
 * quote-snapshot.ts — the point-in-time market/quote record this package
 * hands downstream (docs/architecture.md "Market/quote engine"; "Record
 * families" — `evidence`). A last-trade price is data, not a guarantee
 * that the same price is executable at the desired size: this shape
 * carries a top-of-book bid/ask quote, not a full order book, which is out
 * of scope for BOOT-03's single synthetic route.
 *
 * Every price and quantity is a `DecimalString` (@vigil/contracts
 * money.ts): never a JavaScript number, never routed through
 * `parseFloat`/`Number()`/`toFixed`. Beyond the wire-format check
 * `decimalStringSchema` already runs, every price and quantity here must
 * be strictly positive: `"-1"`, `"0"`, and `"0.00"` are schema-legal
 * `DecimalString`s (negative and zero are both valid amounts elsewhere —
 * a reservation, a fee — so `decimalStringSchema` itself has no opinion
 * on sign) but corrupt top-of-book liquidity, since a quote cannot
 * legitimately offer a non-positive price or size. Positivity is decided
 * from the string alone (no leading "-", and not the zero spelling), not
 * by parsing it as a number.
 *
 * This schema does not reject a crossed book (`askPrice` at or below
 * `bidPrice`) — that comparison needs decimal arithmetic on two
 * `DecimalString` values, and this package deliberately carries no
 * decimal-arithmetic library yet (this package's README, "What it must
 * never do"). A crossed-book check lands with whatever decimal-comparison
 * primitive that future slice adds, not as an arithmetic implementation
 * here.
 */

// Matches exactly the "this decimal string represents zero" branch of
// decimalStringSchema's own DECIMAL_STRING_PATTERN — "0", "0.0", "0.00",
// and so on — so this stays in lock-step with that pattern's definition
// of zero rather than re-deriving it independently.
const ZERO_DECIMAL_STRING_PATTERN = /^0(?:\.0+)?$/;

function positiveDecimalString(fieldName: string) {
  return decimalStringSchema.refine(
    (value) => !value.startsWith("-") && !ZERO_DECIMAL_STRING_PATTERN.test(value),
    {
      message: `${fieldName} must be a strictly positive decimal string — a quote cannot offer a non-positive price or size`,
    },
  );
}

export const quoteSnapshotSchema = z.object({
  instrumentId: instrumentIdSchema,
  bidPrice: positiveDecimalString("bidPrice"),
  askPrice: positiveDecimalString("askPrice"),
  bidQuantity: positiveDecimalString("bidQuantity"),
  askQuantity: positiveDecimalString("askQuantity"),
  timestamps: quoteTimestampsSchema,
});

export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
