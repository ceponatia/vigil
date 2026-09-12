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
 * `parseFloat`/`Number()`/`toFixed`.
 *
 * This schema does not reject a crossed book (`askPrice` at or below
 * `bidPrice`) — that comparison needs decimal arithmetic on two
 * `DecimalString` values, and this package deliberately carries no
 * decimal-arithmetic library yet (this package's README, "What it must
 * never do"). A crossed-book check lands with whatever decimal-comparison
 * primitive that future slice adds, not as an arithmetic implementation
 * here.
 */
export const quoteSnapshotSchema = z.object({
  instrumentId: instrumentIdSchema,
  bidPrice: decimalStringSchema,
  askPrice: decimalStringSchema,
  bidQuantity: decimalStringSchema,
  askQuantity: decimalStringSchema,
  timestamps: quoteTimestampsSchema,
});

export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
