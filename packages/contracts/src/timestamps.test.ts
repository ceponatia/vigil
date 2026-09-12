import { describe, expect, it } from "vitest";

import { TIMESTAMP_STAGES, ageMs, isoUtcTimestampSchema, quoteTimestampsSchema, timestampFamilySchema } from "./timestamps";
import type { IsoUtcTimestamp } from "./timestamps";

describe("isoUtcTimestampSchema", () => {
  const validInputs = [
    "2024-01-01T00:00:00Z",
    "2024-01-01T00:00:00.0Z",
    "2024-01-01T00:00:00.00Z",
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.123Z",
    "1970-01-01T00:00:00Z",
  ];

  it.each(validInputs)("accepts %s — a well-formed ISO-8601 UTC timestamp", (input) => {
    expect(isoUtcTimestampSchema.safeParse(input).success).toBe(true);
  });

  const invalidCases: ReadonlyArray<{ readonly name: string; readonly input: unknown; readonly catches: string }> = [
    {
      name: "an offset instead of Z",
      input: "2024-01-01T00:00:00+02:00",
      catches: "a schema that allows an offset would accept a non-UTC wire timestamp, breaking every downstream age comparison that assumes UTC",
    },
    {
      name: "a zero offset spelled +00:00 rather than Z",
      input: "2024-01-01T00:00:00+00:00",
      catches: "a schema configured with { offset: true } would admit a second spelling of the same instant, so one timestamp could be persisted two ways and no stored value could be compared as a string",
    },
    {
      name: "a naive local datetime carrying no timezone designator at all",
      input: "2024-01-01T00:00:00",
      catches: "a schema configured with { local: true } would accept a timestamp whose zone is unknown, and every age comparison downstream would silently read it in whatever zone the reader assumed",
    },
    {
      name: "missing the time component",
      input: "2024-01-01",
      catches: "a date-only schema would accept a value with no time-of-day precision, which the timestamp family requires",
    },
    {
      name: "not a date at all",
      input: "not-a-timestamp",
      catches: "an unconstrained string schema would accept arbitrary text as a timestamp",
    },
    {
      name: "a bare epoch-millisecond number",
      input: 1_700_000_000_000,
      catches: "a schema built on z.number() would accept epoch milliseconds instead of the documented ISO-8601 string wire format",
    },
    {
      name: "a JS Date object",
      input: new Date("2024-01-01T00:00:00Z"),
      catches: "a schema that accepts z.date() would let a Date object (which serializes inconsistently and is never the wire format) through construction call sites",
    },
    { name: "null", input: null, catches: "a schema without a required string type would accept a missing timestamp as valid" },
    {
      name: "microsecond precision",
      input: "2024-01-01T00:00:00.123456Z",
      catches:
        "a schema with no precision cap would accept a value finer than anything vigil stores: `timestamptz(3)` and `Date.parse` both keep milliseconds, so this instant is written back 456 microseconds earlier than it was supplied, and no reader can tell it was changed",
    },
    {
      name: "nanosecond precision",
      input: "2024-01-01T00:00:00.000000001Z",
      catches:
        "the same truncation from a chain or venue timestamp, which is where nine-digit fractions actually come from",
    },
  ];

  it.each(invalidCases)("$name is rejected without throwing — catches: $catches", ({ input }) => {
    expect(() => isoUtcTimestampSchema.safeParse(input)).not.toThrow();
    expect(isoUtcTimestampSchema.safeParse(input).success).toBe(false);
  });
});

// Registry-derived, mirroring operating-mode.test.ts's shape: the schema's
// keys are compared against TIMESTAMP_STAGES rather than hand-copied, so
// this suite notices if the schema and the registry comment/array drift
// apart from each other.
describe("timestampFamilySchema", () => {
  it("is driven by a non-empty stage registry", () => {
    expect(TIMESTAMP_STAGES.length).toBeGreaterThan(0);
  });

  it("declares exactly the eleven documented lifecycle stages", () => {
    expect(TIMESTAMP_STAGES.length).toBe(11);
  });

  it("has exactly one schema field per TIMESTAMP_STAGES entry, with no extra or missing field", () => {
    const schemaKeys = Object.keys(timestampFamilySchema.shape).sort();
    const registryKeys = [...TIMESTAMP_STAGES].sort();
    expect(schemaKeys).toEqual(registryKeys);
  });

  it("accepts an empty object — every stage is optional because a given record fills in only the stages it actually produces", () => {
    expect(timestampFamilySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partially-filled record and rejects a malformed value for a present stage", () => {
    expect(timestampFamilySchema.safeParse({ ingestedAt: "2024-01-01T00:00:00Z" }).success).toBe(true);
    expect(timestampFamilySchema.safeParse({ ingestedAt: "not-a-timestamp" }).success).toBe(false);
  });
});

describe("quoteTimestampsSchema", () => {
  it("requires both quoteAcquiredAt and ingestedAt — a quote snapshot cannot be aged without the acquisition stage, and cannot be traced without the ingestion stage", () => {
    expect(
      quoteTimestampsSchema.safeParse({ quoteAcquiredAt: "2024-01-01T00:00:00Z", ingestedAt: "2024-01-01T00:00:01Z" }).success,
    ).toBe(true);
    expect(quoteTimestampsSchema.safeParse({ quoteAcquiredAt: "2024-01-01T00:00:00Z" }).success).toBe(false);
    expect(quoteTimestampsSchema.safeParse({ ingestedAt: "2024-01-01T00:00:01Z" }).success).toBe(false);
    expect(quoteTimestampsSchema.safeParse({}).success).toBe(false);
  });
});

describe("ageMs", () => {
  const parse = (value: string): IsoUtcTimestamp => isoUtcTimestampSchema.parse(value);

  it("returns 0 for identical timestamps", () => {
    const t = parse("2024-01-01T00:00:00Z");
    expect(ageMs(t, t)).toBe(0);
  });

  it("returns the exact millisecond delta when now is after the timestamp — the ordinary aging case", () => {
    const timestamp = parse("2024-01-01T00:00:00.000Z");
    const now = parse("2024-01-01T00:00:05.500Z");
    expect(ageMs(timestamp, now)).toBe(5500);
  });

  it("returns a negative value when now precedes the timestamp — a future-dated timestamp is not 'negative age fresh', it is a signal a caller must treat as corrupt", () => {
    const timestamp = parse("2024-01-01T00:00:10Z");
    const now = parse("2024-01-01T00:00:00Z");
    expect(ageMs(timestamp, now)).toBe(-10_000);
  });

  it("is a pure function of its two arguments — calling it twice with the same inputs returns the same result, proving no hidden clock read backs it", () => {
    const timestamp = parse("2020-06-15T12:00:00Z");
    const now = parse("2020-06-15T12:00:03Z");
    expect(ageMs(timestamp, now)).toBe(ageMs(timestamp, now));
  });
});
