import { isoUtcTimestampSchema } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import { counterAccount, holdingsAccount } from "./accounts";
import { parseJournalEntry } from "./journal";
import { instantMs, isStrictlyBefore } from "./timestamps";
import { TEST_PROVENANCE, TEST_STABLE_ASSET, TEST_STABLE_SCALE } from "./test-support/journal-fixtures";

// What the format is, and what it rejects, belongs to
// `packages/contracts/src/timestamps.ts` and is tested there — including the
// at-most-milliseconds precision cap, which protects every consumer of a
// `timestamptz(3)` column rather than this package alone.
//
// What this file owns is the ledger's own path: that an entry carrying an
// instant the application cannot store exactly is refused as a diagnostic
// rather than posted, and that the two pure time helpers order instants the
// way the reservation window depends on.

describe("a persisted entry's timestamps", () => {
  // Through `parseJournalEntry`, which takes `unknown`: that is how a
  // timestamp the application did not produce actually arrives — a database
  // row, a replay file — and it is the path that has to refuse rather than
  // throw (docs/resilience.md §5).
  function persistedWith(occurredAt: string): unknown {
    return {
      entryId: "entry-timestamped",
      kind: "contribution",
      occurredAt,
      recordedAt: "2026-01-02T03:04:06.000Z",
      correlationId: "corr-timestamped",
      idempotencyKey: "idem-timestamped",
      intentId: null,
      reversesEntryId: null,
      provenance: TEST_PROVENANCE,
      lines: [
        {
          account: holdingsAccount(TEST_STABLE_ASSET, "available"),
          scale: TEST_STABLE_SCALE,
          amountBase: 1n,
          direction: "debit",
        },
        {
          account: counterAccount("contributed-capital", TEST_STABLE_ASSET),
          scale: TEST_STABLE_SCALE,
          amountBase: 1n,
          direction: "credit",
        },
      ],
    };
  }

  const refused: ReadonlyArray<{ name: string; occurredAt: string; catches: string }> = [
    {
      name: "microsecond precision",
      occurredAt: "2026-01-02T03:04:05.0004Z",
      catches:
        "an event time finer than the millisecond the journal stores, which comes back 400 microseconds early with nothing in the record to say it changed",
    },
    {
      name: "a calendar day that does not exist",
      occurredAt: "2026-02-30T00:00:00.000Z",
      catches: "a date `new Date` would roll forward to March 2 rather than reject, filing the entry on a day it did not happen",
    },
    {
      name: "a local time with an offset",
      occurredAt: "2026-01-02T03:04:05+01:00",
      catches: "a non-UTC instant, where two entries an hour apart would replay as simultaneous",
    },
  ];

  it.each(refused)("refuses a persisted entry whose occurredAt is $name — catches: $catches", ({ occurredAt }) => {
    const result = parseJournalEntry(persistedWith(occurredAt));

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MALFORMED_ENTRY");
    }
  });

  it("accepts the precisions the journal can store exactly — catches a cap tightened to exactly three digits, which would refuse a producer that trims trailing zeros", () => {
    for (const occurredAt of ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.0Z", "2026-01-02T03:04:05.123Z"]) {
      expect([occurredAt, parseJournalEntry(persistedWith(occurredAt)).outcome]).toEqual([occurredAt, "valid"]);
    }
  });
});

describe("time arithmetic", () => {
  it("orders two validated instants and is false for equal ones — the reservation window check reads this, and a `<=` here would admit a hold that expires at the instant it is taken", () => {
    const earlier = isoUtcTimestampSchema.parse("2026-01-02T03:04:05.000Z");
    const later = isoUtcTimestampSchema.parse("2026-01-02T03:04:05.001Z");

    expect(isStrictlyBefore(earlier, later)).toBe(true);
    expect(isStrictlyBefore(later, earlier)).toBe(false);
    expect(isStrictlyBefore(earlier, earlier)).toBe(false);
  });

  it("reads epoch milliseconds without a clock — catches a helper that reached for Date.now() and made every replay depend on when it ran", () => {
    expect(instantMs(isoUtcTimestampSchema.parse("1970-01-01T00:00:01.500Z"))).toBe(1_500);
  });
});
