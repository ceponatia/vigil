import { describe, expect, it } from "vitest";

import { REASON_CODES, reasonCodeSchema } from "./reason-codes";
import type { ReasonCode } from "./reason-codes";

// Table-driven from the registry itself (REASON_CODES), never a
// hand-copied list, mirroring operating-mode.test.ts's shape — this suite
// cannot drift from its own registry the way a separately typed-out list
// of codes could.
//
// As with operating-mode.test.ts, deriving from the registry means this
// suite does not own the registry's *contents*: it cannot notice a code
// silently dropped from or added to REASON_CODES relative to
// docs/policy.md. That cross-check belongs to the planned
// `scripts/check-docs.mjs` section-citation check (`pnpm lint:docs`), not
// here. What this suite CAN do is keep the registry from drifting
// internally — wrong count, a duplicate, or an emptied array passing
// vacuously.
describe("REASON_CODES registry", () => {
  it("is non-empty — an emptied registry would make every registry-derived case below generate zero tests and report green while no code parsed at all", () => {
    expect(REASON_CODES.length).toBeGreaterThan(0);
  });

  it("holds exactly the twenty codes docs/policy.md's table defines — a count drift means a code was added or removed without updating both places", () => {
    expect(REASON_CODES.length).toBe(20);
  });

  it("contains no duplicate — a copy-pasted duplicate would pass a naive non-empty check while corrupting the derived enum's .options", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it("contains only upper-snake-case members — a lowercase or mixed-case addition would be a spelling drift from docs/policy.md's convention", () => {
    for (const code of REASON_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("reasonCodeSchema", () => {
  it.each(REASON_CODES)("registry member %s parses to itself — a transforming schema would return a different value", (code: ReasonCode) => {
    const result = reasonCodeSchema.safeParse(code);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(code);
    }
  });

  it("exposes exactly the REASON_CODES registry via .options — a hand-copied .options list here could drift from the registry", () => {
    expect(reasonCodeSchema.options).toEqual(REASON_CODES);
  });

  it("rejects a lowercase spelling without throwing — a case-insensitive schema would let a lowercase typo silently resolve to a real code", () => {
    expect(() => reasonCodeSchema.safeParse("stale_quote")).not.toThrow();

    const result = reasonCodeSchema.safeParse("stale_quote");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown code without throwing — an unconstrained string schema would accept any spelling as a reason code, defeating the point of a closed registry", () => {
    expect(() => reasonCodeSchema.safeParse("NOT_A_REAL_CODE")).not.toThrow();

    const result = reasonCodeSchema.safeParse("NOT_A_REAL_CODE");
    expect(result.success).toBe(false);
  });

  it("rejects a non-string value without throwing — schema-legal or not, this boundary never throws into the caller (docs/resilience.md §5)", () => {
    expect(() => reasonCodeSchema.safeParse(null)).not.toThrow();
    expect(() => reasonCodeSchema.safeParse(undefined)).not.toThrow();
    expect(() => reasonCodeSchema.safeParse(42)).not.toThrow();

    expect(reasonCodeSchema.safeParse(null).success).toBe(false);
    expect(reasonCodeSchema.safeParse(undefined).success).toBe(false);
    expect(reasonCodeSchema.safeParse(42).success).toBe(false);
  });
});
