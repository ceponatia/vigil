import { z } from "zod";

/**
 * Matches the wire representation of a decimal number: an optional leading
 * `-`, an integer part that is either `0` or a non-zero digit followed by
 * more digits (no leading zeros), and an optional fractional part of one
 * or more digits. Deliberately excludes exponent notation, a leading `+`,
 * whitespace, thousands separators, and a trailing bare `.` — each of
 * those is a way float syntax or a formatting artifact could reach the
 * wire (docs/resilience.md).
 */
export const DECIMAL_STRING_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * The wire type for every money amount, quantity, and price in this
 * application (docs/architecture.md "Contracts"): a decimal string, never
 * a floating-point number. Arithmetic on this value is out of scope for
 * this package — `packages/contracts` never adds a decimal-arithmetic
 * library (see this package's README, "What it must never do"); this
 * schema only proves the string is well-formed before it crosses a trust
 * boundary.
 */
export const decimalStringSchema = z.string().regex(DECIMAL_STRING_PATTERN, {
  error:
    "expected a decimal string: optional leading -, digits only, no exponent, no leading zeros, no trailing dot",
});

export type DecimalString = z.infer<typeof decimalStringSchema>;
