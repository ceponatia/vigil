import { describe, expect, it } from "vitest";

import { parsePolicyConfig, policyConfigSchema, scaleBoundedDecimalSchema, MAX_QUANTITY_SCALE } from "./config";
import { entryZoneSchema } from "./eligibility";
import { sizingInputsSchema } from "./sizing";
import { RAW_TEST_CONFIG } from "./test-support/fixtures";

const withField = (overrides: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
  ...RAW_TEST_CONFIG,
  ...overrides,
});

const withoutField = (field: keyof typeof RAW_TEST_CONFIG): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...RAW_TEST_CONFIG };
  delete copy[field];
  return copy;
};

// Kills the "a missing or nonsensical limit silently became a permissive
// one" bug class. docs/policy.md's numerical table is explicitly unapproved
// discussion defaults, so there is no correct fallback for any field here —
// the only safe answer to a malformed limit set is refusal
// (docs/resilience.md §1).
describe("parsePolicyConfig — a valid limit set", () => {
  it("accepts a complete, well-signed set and hands back the parsed values", () => {
    const result = parsePolicyConfig(RAW_TEST_CONFIG);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.config.quantityScale).toBe(2);
      expect(result.config.minimumQuantity).toBe("0.5");
      expect(result.config.maxQuoteAgeMs).toBe(5_000);
    }
  });
});

describe("parsePolicyConfig — supplies no default for any limit", () => {
  it.each([
    "maxQuoteAgeMs",
    "maxReconciliationAgeMs",
    "minimumNetEdgeQuote",
    "quantityScale",
    "minimumQuantity",
    "minimumNotionalQuote",
  ] as const)(
    "refuses a set missing %s rather than substituting a value nobody approved",
    (field) => {
      const result = parsePolicyConfig(withoutField(field));
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason.source).toBe("input");
        expect(result.refusal.reason.code).toBe("MALFORMED_POLICY_CONFIG");
        expect(result.refusal.detail).toContain(field);
      }
    },
  );
});

describe("parsePolicyConfig — fail-open sign and range guards", () => {
  it("refuses a negative minimumNetEdgeQuote — it would let a proposal with negative expected edge clear its own threshold", () => {
    const result = parsePolicyConfig(withField({ minimumNetEdgeQuote: "-1" }));
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MALFORMED_POLICY_CONFIG");
    }
  });

  it("accepts a zero minimumNetEdgeQuote — break-even is a threshold an owner may legitimately set, unlike a negative one", () => {
    expect(parsePolicyConfig(withField({ minimumNetEdgeQuote: "0" })).outcome).toBe("ok");
  });

  it.each(["0", "-0.5"])(
    "refuses a non-positive minimumQuantity (%s) — it would disable the MINIMUM_NOTIONAL skip entirely, since every size clears a minimum of zero",
    (value) => {
      expect(parsePolicyConfig(withField({ minimumQuantity: value })).outcome).toBe("refused");
    },
  );

  it.each(["0", "-1"])(
    "refuses a non-positive minimumNotionalQuote (%s) for the same reason",
    (value) => {
      expect(parsePolicyConfig(withField({ minimumNotionalQuote: value })).outcome).toBe("refused");
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an unusable freshness threshold (%s) rather than reading it as 'everything passes'",
    (value) => {
      expect(parsePolicyConfig(withField({ maxQuoteAgeMs: value })).outcome).toBe("refused");
    },
  );

  it("refuses a quantityScale beyond the representable bound", () => {
    expect(parsePolicyConfig(withField({ quantityScale: MAX_QUANTITY_SCALE + 1 })).outcome).toBe("refused");
    expect(parsePolicyConfig(withField({ quantityScale: -1 })).outcome).toBe("refused");
  });

  it("accepts a quantityScale of zero — a venue that trades only whole units is real, and rounding down to 0dp is still rounding down", () => {
    expect(parsePolicyConfig(withField({ quantityScale: 0 })).outcome).toBe("ok");
  });

  it("refuses a float-shaped money literal, since decimal strings are the wire form", () => {
    expect(parsePolicyConfig(withField({ minimumQuantity: 0.5 })).outcome).toBe("refused");
    expect(parsePolicyConfig(withField({ minimumQuantity: "1e-3" })).outcome).toBe("refused");
  });
});

describe("parsePolicyConfig — unknown keys", () => {
  it("refuses an unknown key rather than ignoring it: a typo'd limit name would otherwise leave the real limit missing AND discard the typo silently", () => {
    const result = parsePolicyConfig({ ...RAW_TEST_CONFIG, minimumNotional: "50" });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.reason.code).toBe("MALFORMED_POLICY_CONFIG");
    }
  });
});

describe("parsePolicyConfig — never throws", () => {
  it.each([null, undefined, 42, "a string", { nothing: "useful" }])(
    "returns a refusal instead of throwing for %s (docs/resilience.md §4, §5)",
    (raw) => {
      expect(() => parsePolicyConfig(raw)).not.toThrow();
      expect(parsePolicyConfig(raw).outcome).toBe("refused");
    },
  );
});


/**
 * Regression for the PR #41 CI failure. `"1e-3"` correctly fails
 * `DECIMAL_STRING_PATTERN`, but Zod 4 aggregates issues instead of
 * short-circuiting, so the `.refine()` attached to that string check runs
 * anyway — on the rejected value. The predicates it called then threw out of
 * `parsePolicyConfig`, because a `throw` inside a refine escapes `safeParse`
 * rather than becoming an issue. That is a docs/resilience.md §4 violation
 * at a trust boundary: schema-illegal input must produce a refusal.
 *
 * Verified against zod 4.6.2 rather than assumed, because assuming zod 3's
 * short-circuit semantics is precisely what produced the defect.
 */
const SHAPE_INVALID_MONEY = ["1e-3", "+1", " 1", "1.", "-0", "", "abc"];

describe("every money refine refuses a shape-invalid string instead of throwing", () => {
  it.each(SHAPE_INVALID_MONEY)(
    "parsePolicyConfig refuses minimumQuantity %j (positiveDecimalSchema -> isPositive) without throwing",
    (value) => {
      expect(() => parsePolicyConfig(withField({ minimumQuantity: value }))).not.toThrow();
      const result = parsePolicyConfig(withField({ minimumQuantity: value }));
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusal.reason.code).toBe("MALFORMED_POLICY_CONFIG");
      }
    },
  );

  it.each(SHAPE_INVALID_MONEY)(
    "parsePolicyConfig refuses minimumNetEdgeQuote %j (nonNegativeDecimalSchema -> isNegative) without throwing",
    (value) => {
      expect(() => parsePolicyConfig(withField({ minimumNetEdgeQuote: value }))).not.toThrow();
      expect(parsePolicyConfig(withField({ minimumNetEdgeQuote: value })).outcome).toBe("refused");
    },
  );

  it.each(SHAPE_INVALID_MONEY)(
    "scaleBoundedDecimalSchema refuses %j without throwing (scaleOf -> NaN, so the bound comparison is false)",
    (value) => {
      expect(() => scaleBoundedDecimalSchema.safeParse(value)).not.toThrow();
      expect(scaleBoundedDecimalSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(SHAPE_INVALID_MONEY)(
    "entryZoneSchema refuses a shape-invalid min (%j) without throwing — in zod 4 this object-level refine runs even though the field failed, so compareDecimal must be gated behind isDecomposable",
    (value) => {
      const zone = { min: value, max: "2" };
      expect(() => entryZoneSchema.safeParse(zone)).not.toThrow();
      expect(entryZoneSchema.safeParse(zone).success).toBe(false);
    },
  );

  it.each(SHAPE_INVALID_MONEY)("entryZoneSchema refuses a shape-invalid max (%j) without throwing", (value) => {
    const zone = { min: "1", max: value };
    expect(() => entryZoneSchema.safeParse(zone)).not.toThrow();
    expect(entryZoneSchema.safeParse(zone).success).toBe(false);
  });

  it.each(SHAPE_INVALID_MONEY)(
    "sizingInputsSchema refuses a shape-invalid executablePrice (%j) without throwing",
    (value) => {
      const inputs = {
        fundsAvailableQuote: "1000",
        exposureHeadroomQuote: "5000",
        executableLiquidityBase: "80",
        adverseLossBudgetQuote: "250",
        stopDistanceQuote: "5",
        executablePrice: value,
      };
      expect(() => sizingInputsSchema.safeParse(inputs)).not.toThrow();
      expect(sizingInputsSchema.safeParse(inputs).success).toBe(false);
    },
  );
});

/**
 * The net that catches the NEXT refine, not just today's four. Any schema
 * this package exports must survive a shape-invalid string in any field
 * without throwing — so a refine added by #35 or a later slice that calls an
 * arithmetic helper directly fails here rather than in production.
 */
describe("no exported schema throws on a shape-invalid string in any field", () => {
  // Typed structurally rather than as a union of three zod schema types:
  // all this needs is "something with a safeParse", and a union of distinct
  // ZodType instances makes the method call needlessly awkward to type.
  type ParsesAnything = { readonly safeParse: (value: unknown) => { readonly success: boolean } };

  const cases: readonly (readonly [string, ParsesAnything, Readonly<Record<string, unknown>>])[] = [
    ["policyConfigSchema", policyConfigSchema, { ...RAW_TEST_CONFIG }],
    [
      "sizingInputsSchema",
      sizingInputsSchema,
      {
        fundsAvailableQuote: "1000",
        exposureHeadroomQuote: "5000",
        executableLiquidityBase: "80",
        adverseLossBudgetQuote: "250",
        stopDistanceQuote: "5",
        executablePrice: "100",
      },
    ],
    ["entryZoneSchema", entryZoneSchema, { min: "1", max: "2" }],
  ];

  it.each(cases)("%s tolerates a poisoned field in every position", (_name, schema, valid) => {
    for (const key of Object.keys(valid)) {
      for (const bad of SHAPE_INVALID_MONEY) {
        const poisoned = { ...valid, [key]: bad };
        expect(() => schema.safeParse(poisoned)).not.toThrow();
        expect(schema.safeParse(poisoned).success).toBe(false);
      }
    }
  });

  it("the valid baselines themselves still parse, so the loop above is not vacuously green on an already-broken fixture", () => {
    for (const [, schema, valid] of cases) {
      expect(schema.safeParse(valid).success).toBe(true);
    }
  });
});
