import type { StoreEntry } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { latestEntries } from "./audit";

// The defect this file kills: an audit window that shows the oldest
// entries instead of the newest — `loadJournalEntries` returns the durable
// replay order, oldest first, so a missing reverse leaves an operator
// reading the first 50 things that ever happened — or that returns the
// whole journal for `limit` 0 through `Array.prototype.slice(-0)`.

function entry(entryId: string): StoreEntry {
  return {
    entryId,
    kind: "trade",
    occurredAt: "2024-06-01T12:00:00.000Z",
    recordedAt: "2024-06-01T12:00:00.000Z",
    correlationId: `corr-${entryId}`,
    idempotencyKey: `idem-${entryId}`,
    intentId: null,
    reversesEntryId: null,
    provenance: {
      policyVersion: "policy-1",
      strategyVersion: "strategy-1",
      modelVersion: null,
      portfolioSnapshotVersion: null,
      marketSnapshotVersion: null,
    },
    lines: [],
  };
}

describe("latestEntries", () => {
  it("reverses an oldest-first list to newest-first", () => {
    const entries = [entry("1"), entry("2"), entry("3")];
    expect(latestEntries(entries, 10).map((e) => e.entryId)).toStrictEqual(["3", "2", "1"]);
  });

  it("caps the result at limit, keeping only the most recent entries", () => {
    const entries = [entry("1"), entry("2"), entry("3"), entry("4"), entry("5")];
    const result = latestEntries(entries, 2);
    expect(result.map((e) => e.entryId)).toStrictEqual(["5", "4"]);
  });

  it("returns everything, newest first, when limit exceeds the list length", () => {
    const entries = [entry("1"), entry("2")];
    expect(latestEntries(entries, 50).map((e) => e.entryId)).toStrictEqual(["2", "1"]);
  });

  it("returns an empty list for limit 0, never Array.prototype.slice(-0)'s whole-array behavior", () => {
    const entries = [entry("1"), entry("2")];
    expect(latestEntries(entries, 0)).toStrictEqual([]);
  });

  it("returns an empty list for a negative limit", () => {
    const entries = [entry("1")];
    expect(latestEntries(entries, -1)).toStrictEqual([]);
  });

  it("returns an empty list for an empty input", () => {
    expect(latestEntries([], 50)).toStrictEqual([]);
  });
});
