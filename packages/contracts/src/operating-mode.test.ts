import { describe, expect, it } from "vitest";

import { OPERATING_MODES, operatingModeSchema } from "./operating-mode";
import type { OperatingMode } from "./operating-mode";

// Table-driven from the registry itself (OPERATING_MODES), never a
// hand-copied list, so this suite cannot drift from docs/policy.md
// "Operating modes" the way a separately typed-out list of modes could.
//
// The consequence of deriving from the registry is that this suite does not
// own the registry's *contents*: it cannot notice a mode being dropped from
// OPERATING_MODES. That claim — that the registry names exactly the modes
// docs/policy.md defines — belongs to the planned `scripts/check-docs.mjs`
// section-citation check (`pnpm lint:docs`, see scripts/README.md), not
// here. The cardinality guard below is the one thing this suite can do
// about it: keep an emptied registry from passing vacuously.
describe("operatingModeSchema", () => {
  it("is driven by a non-empty registry — an emptied OPERATING_MODES would make every registry-derived case below generate zero tests and report green while no mode parsed at all", () => {
    expect(OPERATING_MODES.length).toBeGreaterThan(0);
  });

  it.each(OPERATING_MODES)("registry member %s parses to itself — a transforming schema would return a different value", (mode: OperatingMode) => {
    const result = operatingModeSchema.safeParse(mode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(mode);
    }
  });

  it("exposes exactly the OPERATING_MODES registry via .options — a hand-copied .options list here could drift from the registry", () => {
    expect(operatingModeSchema.options).toEqual(OPERATING_MODES);
  });

  it("rejects a lowercase spelling without throwing — a case-insensitive schema would grant LIVE from a lowercase config typo", () => {
    expect(() => operatingModeSchema.safeParse("live")).not.toThrow();

    const result = operatingModeSchema.safeParse("live");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown mode without throwing — an unconstrained string schema would accept any spelling as a mode", () => {
    expect(() => operatingModeSchema.safeParse("TESTING")).not.toThrow();

    const result = operatingModeSchema.safeParse("TESTING");
    expect(result.success).toBe(false);
  });
});
