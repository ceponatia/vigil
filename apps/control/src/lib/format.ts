/**
 * format.ts — render an exact integer count of base units back to a decimal
 * string, for display only. This intentionally does NOT reuse
 * `packages/ledger/src/base-units.ts`'s `fromBaseUnits`: apps/control may
 * not import `@vigil/ledger` at all (docs/architecture.md "Layer graph and
 * import rules"), and a dashboard display value is not a wire boundary — it
 * is read once, formatted, and rendered, so it skips that function's
 * `DecimalString` round-trip validation and its 78-digit range check on
 * purpose. Money is still never a float here: every step below is `bigint`
 * arithmetic, never `parseFloat`, `Number()`, or `toFixed()`.
 */

/**
 * `units` is an exact base-unit count and `scale` says how many of its
 * rightmost digits are fractional. The sign is handled first, on the
 * magnitude, so a negative amount can never come out as `-0` or with the
 * sign attached to the wrong side of the decimal point.
 */
export function formatBaseUnits(units: bigint, scale: number): string {
  if (units === 0n) {
    return "0";
  }

  const negative = units < 0n;
  const magnitude = negative ? -units : units;

  if (scale === 0) {
    return negative ? `-${magnitude.toString()}` : magnitude.toString();
  }

  const divisor = 10n ** BigInt(scale);
  const whole = magnitude / divisor;
  const remainder = magnitude % divisor;
  const fractionDigits = remainder.toString().padStart(scale, "0").replace(/0+$/, "");
  const unsigned = fractionDigits.length > 0 ? `${whole.toString()}.${fractionDigits}` : whole.toString();

  return negative ? `-${unsigned}` : unsigned;
}
