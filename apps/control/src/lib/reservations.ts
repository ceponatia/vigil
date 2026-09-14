/**
 * reservations.ts — ordering for the dashboard's Reservations section
 * (BOOT-07 brief, "Design").
 */

export type ExpiryOrdered = { readonly expiresAt: string };

/**
 * Ascending by `expiresAt` — the reservation closest to expiring first, so
 * an operator sees what needs attention soonest at the top. A plain string
 * comparison is safe: every timestamp in this application is ISO-8601 UTC
 * at a fixed millisecond precision with a fixed `Z` offset
 * (`@vigil/contracts`'s `isoUtcTimestampSchema`), so lexicographic order
 * over that exact shape equals chronological order.
 */
export function sortByExpiry<T extends ExpiryOrdered>(items: readonly T[]): readonly T[] {
  return items.toSorted((left, right) => (left.expiresAt < right.expiresAt ? -1 : left.expiresAt > right.expiresAt ? 1 : 0));
}
