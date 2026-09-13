import { describe, expect, it } from "vitest";

import { loadControlConfig } from "./env";

// The defect this file kills: a bad or missing config silently defaulting
// to something that looks fine instead of the explicit ConfigError the
// layout is required to render (docs/resilience.md §1 "Fail closed on
// financial authority").

describe("loadControlConfig", () => {
  it("defaults VIGIL_MODE to PAPER when unset", () => {
    const result = loadControlConfig({ DATABASE_URL: "postgresql://vigil@localhost:5436/vigil_dev" });
    expect(result).toStrictEqual({
      outcome: "ok",
      config: { mode: "PAPER", databaseUrl: "postgresql://vigil@localhost:5436/vigil_dev" },
    });
  });

  it.each(["PAPER", "SHADOW", "LIVE", "PAUSED"] as const)("accepts VIGIL_MODE=%s", (mode) => {
    const result = loadControlConfig({ VIGIL_MODE: mode, DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({ outcome: "ok", config: { mode, databaseUrl: "postgresql://x/y" } });
  });

  it("refuses a VIGIL_MODE outside the operating-mode vocabulary", () => {
    const result = loadControlConfig({ VIGIL_MODE: "TURBO", DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({
      outcome: "error",
      code: "INVALID_VIGIL_MODE",
      detail: 'VIGIL_MODE "TURBO" is not one of PAPER, SHADOW, LIVE, PAUSED',
    });
  });

  it("refuses a missing DATABASE_URL rather than reading an empty connection string", () => {
    const result = loadControlConfig({ VIGIL_MODE: "PAPER" });
    expect(result).toStrictEqual({
      outcome: "error",
      code: "MISSING_DATABASE_URL",
      detail: "DATABASE_URL is not set; the dashboard has no database to read",
    });
  });

  it("refuses a DATABASE_URL that is only whitespace", () => {
    const result = loadControlConfig({ VIGIL_MODE: "PAPER", DATABASE_URL: "   " });
    expect(result.outcome).toBe("error");
  });
});
