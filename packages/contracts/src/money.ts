import { z } from "zod";

/**
 * Matches the wire representation of a decimal amount: an integer part that
 * is either `0` or a non-zero digit followed by more digits (no leading
 * zeros), an optional fractional part of one or more digits, and a leading
 * `-` only on a non-zero amount. Deliberately excludes exponent notation, a
 * leading `+`, whitespace, thousands separators, a trailing bare `.`, and
 * negative zero (`-0`, `-0.0…`) — each of those is a way float syntax or a
 * formatting artifact could reach the wire (docs/resilience.md), and
 * negative zero would put two spellings of one amount onto it.
 *
 * Structure: `0` with an optional all-zero fraction, or an optionally
 * negative non-zero amount (a non-zero integer part, or `0.` followed by a
 * fraction that contains a non-zero digit).
 */
export const DECIMAL_STRING_PATTERN = /^(?:0(?:\.0+)?|-?(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))$/;

/**
 * The wire type for every money amount, quantity, and price in this
 * application (docs/architecture.md "Contracts"): a decimal string, never
 * a floating-point number. Arithmetic on this value is out of scope for
 * this package — `packages/contracts` never adds a decimal-arithmetic
 * library (see this package's README, "What it must never do"); this
 * schema only proves the string is well-formed before it crosses a trust
 * boundary.
 *
 * Well-formed is not canonical: `1`, `1.0`, and `1.00` all parse. Equality
 * and any key derived from an amount (an idempotency key, a journal match)
 * compare the normalized numeric value, never the raw string. Precision and
 * scale bounds are not enforced here — they belong to the ledger's numeric
 * columns and arrive with `packages/db`.
 *
 * The type is branded: the only way to hold a `DecimalString` is to have
 * parsed one, so a function typed to take it cannot be handed an arbitrary
 * string or a `toFixed()` result.
 */
export const decimalStringSchema = z
  .string()
  .regex(DECIMAL_STRING_PATTERN, {
    error:
      "expected a decimal string: digits only, no exponent, no leading zeros, no trailing dot, no negative zero",
  })
  .brand<"DecimalString">();

export type DecimalString = z.infer<typeof decimalStringSchema>;
