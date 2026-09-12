import { describe, expect, it } from "vitest";

import { OPERATING_MODES, operatingModeSchema } from "./operating-mode";
import type { OperatingMode } from "./operating-mode";

// Table-driven from the registry itself (OPERATING_MODES), never a
// hand-copied list, so this suite cannot drift from docs/policy.md
// "Operating modes" the way a separately typed-out list of modes could.
describe("operatingModeSchema", () => {
  it.each(OPERATING_MODES)("registry member %s parses to itself", (mode: OperatingMode) => {
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
