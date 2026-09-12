import { describe, expect, it } from "vitest";

import { DECIMAL_STRING_PATTERN, decimalStringSchema } from "./money";

// Plain strings on purpose: `DecimalString` is branded, so the only way to
// hold one is to have parsed it — which is exactly what these cases prove.
const validInputs: readonly string[] = [
  "0",
  "1",
  "-1",
  "0.5",
  "123.456000",
  "-0.000001",
  // Longer than IEEE-754 can represent exactly — proves the schema
  // never routes the value through a JS number.
  "12345678901234567890.123456789",
];

const invalidCases: ReadonlyArray<{ name: string; input: unknown; catches: string }> = [
  {
    name: "1e5",
    input: "1e5",
    catches: "a pattern that admits exponent notation would let float syntax onto the wire",
  },
  {
    name: "01",
    input: "01",
    catches: "a pattern without a leading-zero guard would admit a non-canonical integer part",
  },
  {
    name: ".5",
    input: ".5",
    catches: "a pattern with an optional integer part would admit a bare fractional value",
  },
  {
    name: "1.",
    input: "1.",
    catches: "a pattern with an optional fractional digit run would admit a trailing bare dot",
  },
  {
    name: "empty string",
    input: "",
    catches: "a pattern not anchored at both ends would admit an empty string",
  },
  {
    name: "leading space",
    input: " 1",
    catches: "a pattern without start/end anchors would admit leading whitespace",
  },
  {
    name: "1,000",
    input: "1,000",
    catches: "a pattern that allows thousands separators would admit display-formatted text instead of a wire value",
  },
  {
    name: "+1",
    input: "+1",
    catches: "a pattern that allows a leading + would admit a non-canonical sign",
  },
  {
    name: "NaN",
    input: "NaN",
    catches: "a pattern built from a loose digit class would admit the literal string NaN",
  },
  {
    name: "0x10",
    input: "0x10",
    catches: "a pattern that admits hex digits would let non-decimal notation onto the wire",
  },
  {
    name: "the number 1",
    input: 1,
    catches: "a schema built on z.number() instead of z.string() would accept a float at the type level",
  },
  {
    name: "null",
    input: null,
    catches: "a schema without a required string type would accept a missing amount as valid",
  },
  {
    name: "-0",
    input: "-0",
    catches:
      "a pattern that admits negative zero would put two spellings of one amount on the wire, and a key derived from the quantity would treat one intent as two",
  },
  {
    name: "-0.0",
    input: "-0.0",
    catches: "a pattern that only checks the integer part for negative zero would admit -0.0",
  },
  {
    name: "-0.000",
    input: "-0.000",
    catches: "a pattern that only checks the first fractional digit would admit -0.000",
  },
  {
    name: "undefined",
    input: undefined,
    catches:
      "a .default() or .optional() on the schema would turn a missing amount into a concrete one; the null case above does not catch that, because a zod default fires only on undefined",
  },
];

// The subset of the table above whose input is a string, so the exported
// pattern and the schema can be compared directly: a bare regex has no
// opinion about non-string input, which is the schema's job.
const invalidStringCases = invalidCases.filter(
  (testCase): testCase is (typeof invalidCases)[number] & { input: string } =>
    typeof testCase.input === "string",
);

describe("decimalStringSchema", () => {
  describe("valid decimal strings parse and round-trip unchanged", () => {
    it.each(validInputs)("parses %s unchanged — a coercing or normalizing schema would return a different string", (input) => {
      const result = decimalStringSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(input);
      }
    });
  });

  describe("schema-invalid input fails through safeParse without throwing", () => {
    it.each(invalidCases)("$name is rejected without throwing — catches: $catches", ({ input }) => {
      expect(() => decimalStringSchema.safeParse(input)).not.toThrow();

      const result = decimalStringSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });
});

// `DECIMAL_STRING_PATTERN` is exported from this package alongside the
// schema, so a consumer may validate with either one. These two cases keep
// that second entry point honest; both tables above are reused rather than
// retyped, so the pattern can never be checked against a staler case list
// than the schema is.
describe("DECIMAL_STRING_PATTERN", () => {
  it("accepts and rejects exactly what decimalStringSchema does, for every string case in this file — replacing the schema's reference to this constant with an inline regex literal would let the two entry points disagree about the same amount", () => {
    for (const input of validInputs) {
      expect(DECIMAL_STRING_PATTERN.test(input)).toBe(decimalStringSchema.safeParse(input).success);
    }

    for (const { input } of invalidStringCases) {
      expect(DECIMAL_STRING_PATTERN.test(input)).toBe(decimalStringSchema.safeParse(input).success);
    }
  });

  it("carries no stateful regex flag — a g or y flag added for a replace/match call site would advance lastIndex between calls, so .test() on one amount would alternate between true and false", () => {
    expect(DECIMAL_STRING_PATTERN.global).toBe(false);
    expect(DECIMAL_STRING_PATTERN.sticky).toBe(false);

    // The same values twice: a stateful pattern disagrees with itself here.
    for (const input of [...validInputs, ...validInputs]) {
      expect(DECIMAL_STRING_PATTERN.test(input)).toBe(true);
    }
  });
});
