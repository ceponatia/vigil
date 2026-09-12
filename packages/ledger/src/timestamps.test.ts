import { describe, expect, it } from "vitest";

import { isStrictlyBefore, isoUtcTimestampSchema, ISO_UTC_TIMESTAMP_PATTERN } from "./timestamps";

// The defect this file kills: an event time that is not the time the event
// happened. A timestamp carrying precision finer than the millisecond this
// application stores is truncated on the way into a `timestamptz(3)` column
// and into `Date.parse`, so the record would say the event happened up to a
// millisecond earlier than it did — and a point-in-time replay comparing
// event times would read a value nobody ever wrote (docs/evaluation.md,
// "Point-in-time integrity").

const accepted: readonly string[] = [
  "2026-01-02T03:04:05Z",
  "2026-01-02T03:04:05.0Z",
  "2026-01-02T03:04:05.00Z",
  "2026-01-02T03:04:05.000Z",
  "2026-01-02T03:04:05.123Z",
];

const rejected: ReadonlyArray<{ name: string; value: string; catches: string }> = [
  {
    name: "microseconds",
    value: "2026-01-02T03:04:05.0004Z",
    catches: "a pattern that allows more fractional digits than are stored, so the 0.4 ms is dropped and the record misstates the event time",
  },
  {
    name: "nanoseconds",
    value: "2026-01-02T03:04:05.000000001Z",
    catches: "a chain or venue timestamp at nanosecond precision being accepted and silently rounded",
  },
  {
    name: "a local time with an offset",
    value: "2026-01-02T03:04:05+01:00",
    catches: "a non-UTC instant, where two records an hour apart would compare as simultaneous",
  },
  {
    name: "a calendar day that does not exist",
    value: "2026-02-30T00:00:00.000Z",
    catches: "`new Date` rolling February 30 forward to March 2 rather than failing",
  },
  { name: "a date with no time", value: "2026-01-02", catches: "a date-only value defaulting to midnight in some zone" },
];

describe("isoUtcTimestampSchema", () => {
  it.each(accepted)("accepts %s — millisecond precision is exactly what the database column and Date.parse both keep", (value) => {
    expect(isoUtcTimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each(rejected)("rejects $name without throwing — catches: $catches", ({ value }) => {
    expect(() => isoUtcTimestampSchema.safeParse(value)).not.toThrow();
    expect(isoUtcTimestampSchema.safeParse(value).success).toBe(false);
  });

  it("agrees with the exported pattern on every case above, for the cases the pattern can judge — catches the schema and the constant drifting into two different definitions of the same format", () => {
    for (const value of accepted) {
      expect([value, ISO_UTC_TIMESTAMP_PATTERN.test(value)]).toEqual([value, true]);
    }
    // The calendar-day case is the one the pattern alone cannot catch; it is
    // the refine's job, and the schema above already proves it rejects.
    for (const { value } of rejected.filter((testCase) => testCase.name !== "a calendar day that does not exist")) {
      expect([value, ISO_UTC_TIMESTAMP_PATTERN.test(value)]).toEqual([value, false]);
    }
  });
});

describe("isStrictlyBefore", () => {
  it("orders two validated instants and is false for equal ones — the reservation window check reads this, and a `<=` here would admit a hold that expires at the instant it is taken", () => {
    const earlier = isoUtcTimestampSchema.parse("2026-01-02T03:04:05.000Z");
    const later = isoUtcTimestampSchema.parse("2026-01-02T03:04:05.001Z");

    expect(isStrictlyBefore(earlier, later)).toBe(true);
    expect(isStrictlyBefore(later, earlier)).toBe(false);
    expect(isStrictlyBefore(earlier, earlier)).toBe(false);
  });
});
