import { OPERATING_MODES } from "@vigil/contracts";
import type { OperatingMode } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import { loadControlConfig } from "./env";

// The defect this file kills: a bad or missing config silently defaulting
// to something that looks fine instead of the explicit ConfigError the
// layout is required to render (docs/resilience.md §1 "Fail closed on
// financial authority"), and a dashboard mode vocabulary that drifts from
// `@vigil/contracts`' OPERATING_MODES. Every mode case below is derived
// from that registry rather than hand-copied, so a mode added there is
// exercised here without anyone remembering to add a case.

describe("loadControlConfig", () => {
  it("is driven by a non-empty OPERATING_MODES registry — an emptied registry would generate zero mode cases and still report green", () => {
    expect(OPERATING_MODES.length).toBeGreaterThan(0);
  });

  it("defaults VIGIL_MODE to PAPER when unset", () => {
    const result = loadControlConfig({ DATABASE_URL: "postgresql://vigil@localhost:5436/vigil_dev" });
    expect(result).toStrictEqual({
      outcome: "ok",
      config: { mode: "PAPER", databaseUrl: "postgresql://vigil@localhost:5436/vigil_dev" },
    });
  });

  it.each(OPERATING_MODES)("accepts registry member VIGIL_MODE=%s and returns it unchanged", (mode: OperatingMode) => {
    const result = loadControlConfig({ VIGIL_MODE: mode, DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({ outcome: "ok", config: { mode, databaseUrl: "postgresql://x/y" } });
  });

  it("refuses a VIGIL_MODE outside the operating-mode vocabulary and names every registry member in the diagnostic", () => {
    const result = loadControlConfig({ VIGIL_MODE: "TURBO", DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({
      outcome: "error",
      code: "INVALID_VIGIL_MODE",
      detail: `VIGIL_MODE "TURBO" is not one of ${OPERATING_MODES.join(", ")}`,
    });
    if (result.outcome === "error") {
      for (const mode of OPERATING_MODES) {
        expect(result.detail).toContain(mode);
      }
    }
  });

  it("refuses a missing DATABASE_URL rather than reading an empty connection string", () => {
    const result = loadControlConfig({ VIGIL_MODE: "PAPER" });
    expect(result).toStrictEqual({
      outcome: "error",
      code: "MISSING_DATABASE_URL",
      detail: "DATABASE_URL is not set; the dashboard has no database to read",
    });
  });

  it("refuses a DATABASE_URL that is only whitespace with the same missing-value code", () => {
    const result = loadControlConfig({ VIGIL_MODE: "PAPER", DATABASE_URL: "   " });
    expect(result).toStrictEqual({
      outcome: "error",
      code: "MISSING_DATABASE_URL",
      detail: "DATABASE_URL is not set; the dashboard has no database to read",
    });
  });
});
