import type { StoreEntry } from "@vigil/db";

/**
 * audit.ts — the dashboard's Audit trail window (BOOT-07 brief, "Design":
 * "latest 50 journal entries").
 *
 * `@vigil/db`'s `loadJournalEntries` returns entries oldest-first, ordered
 * by `entry_sequence` — the durable replay order
 * (`packages/db/src/store/journal-store.ts`) — so taking the tail and
 * reversing it is what turns "the whole replay order" into "what an
 * operator wants to see first".
 */

/**
 * The most recent `limit` entries from an oldest-first list, newest first.
 * Always returns an array of length ≤ `limit` — `limit <= 0` returns
 * empty rather than `Array.prototype.slice`'s own `slice(-0)` behavior,
 * which is indistinguishable from `slice(0)` and would return everything.
 */
export function latestEntries(entries: readonly StoreEntry[], limit: number): readonly StoreEntry[] {
  if (limit <= 0) {
    return [];
  }
  return entries.slice(-limit).toReversed();
}
