import { describe, expect, it } from "vitest";

import { decimalStringSchema } from "./money";
import type { DecimalString } from "./money";

describe("decimalStringSchema", () => {
  describe("valid decimal strings parse and round-trip unchanged", () => {
    const validInputs: DecimalString[] = [
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

    it.each(validInputs)("parses %s unchanged", (input) => {
      const result = decimalStringSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(input);
      }
    });
  });

  describe("schema-invalid input fails through safeParse without throwing", () => {
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
    ];

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
