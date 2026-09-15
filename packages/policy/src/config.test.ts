import { describe, expect, it } from "vitest";

import { parsePolicyConfig, MAX_QUANTITY_SCALE } from "./config";
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
