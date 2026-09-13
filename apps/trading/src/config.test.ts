import { describe, expect, it } from "vitest";

import { loadTradingConfig } from "./config";

// The defect this file kills: a runtime that starts up under SHADOW or LIVE
// with no market/strategy/execution pipeline behind it and silently does
// nothing, instead of refusing to start with a diagnostic
// (docs/resilience.md §1 "Fail closed on financial authority";
// apps/trading/README.md "Operating modes").

describe("loadTradingConfig", () => {
  it("starts under PAPER, the default when VIGIL_MODE is unset", () => {
    const result = loadTradingConfig({ DATABASE_URL: "postgresql://vigil@localhost:5436/vigil_dev" });
    expect(result).toStrictEqual({
      outcome: "ok",
      config: { databaseUrl: "postgresql://vigil@localhost:5436/vigil_dev", mode: "PAPER", logLevel: "info" },
    });
  });

  it("starts under PAUSED", () => {
    const result = loadTradingConfig({ VIGIL_MODE: "PAUSED", DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({
      outcome: "ok",
      config: { databaseUrl: "postgresql://x/y", mode: "PAUSED", logLevel: "info" },
    });
  });

  it.each(["SHADOW", "LIVE"] as const)("refuses to start under %s", (mode) => {
    const result = loadTradingConfig({ VIGIL_MODE: mode, DATABASE_URL: "postgresql://x/y" });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.code).toBe("MODE_NOT_STARTABLE");
      expect(result.detail).toContain(mode);
    }
  });

  it("refuses a VIGIL_MODE outside the operating-mode vocabulary", () => {
    const result = loadTradingConfig({ VIGIL_MODE: "TURBO", DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({
      outcome: "refused",
      code: "INVALID_VIGIL_MODE",
      detail: 'VIGIL_MODE "TURBO" is not one of PAPER, SHADOW, LIVE, PAUSED',
    });
  });

  it("refuses a missing DATABASE_URL before ever looking at VIGIL_MODE", () => {
    const result = loadTradingConfig({});
    expect(result).toStrictEqual({
      outcome: "refused",
      code: "MISSING_DATABASE_URL",
      detail: "DATABASE_URL is not set",
    });
  });

  it("refuses an unrecognized LOG_LEVEL", () => {
    const result = loadTradingConfig({ DATABASE_URL: "postgresql://x/y", LOG_LEVEL: "verbose" });
    expect(result).toStrictEqual({
      outcome: "refused",
      code: "INVALID_LOG_LEVEL",
      detail: 'LOG_LEVEL "verbose" is not a valid pino level',
    });
  });
});
