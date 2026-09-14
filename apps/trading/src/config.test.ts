import { OPERATING_MODES } from "@vigil/contracts";
import type { OperatingMode } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import { loadTradingConfig } from "./config";

// The defect this file kills: a runtime that starts up under a mode it has
// no pipeline for — SHADOW, LIVE, or any mode added to OPERATING_MODES
// after this build — and silently does nothing, instead of refusing to
// start with a diagnostic (docs/resilience.md §1 "Fail closed on financial
// authority"; apps/trading/README.md "Operating modes"). The refusal cases
// are derived from the registry rather than hand-copied, so a new operating
// mode is refused by default here instead of quietly joining the startable
// set unnoticed.

const STARTABLE_MODES: readonly OperatingMode[] = ["PAPER", "PAUSED"];
const NON_STARTABLE_MODES = OPERATING_MODES.filter((mode) => !STARTABLE_MODES.includes(mode));

describe("loadTradingConfig", () => {
  it("derives a non-empty non-startable set from OPERATING_MODES — an empty one would generate zero refusal cases and still report green", () => {
    expect(NON_STARTABLE_MODES.length).toBeGreaterThan(0);
  });

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

  it.each(NON_STARTABLE_MODES)(
    "refuses to start under %s, a registry mode this build has no market/strategy/execution pipeline for",
    (mode: OperatingMode) => {
      const result = loadTradingConfig({ VIGIL_MODE: mode, DATABASE_URL: "postgresql://x/y" });
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.code).toBe("MODE_NOT_STARTABLE");
        expect(result.detail).toContain(mode);
      }
    },
  );

  it("refuses a VIGIL_MODE outside the operating-mode vocabulary and names every registry member in the diagnostic", () => {
    const result = loadTradingConfig({ VIGIL_MODE: "TURBO", DATABASE_URL: "postgresql://x/y" });
    expect(result).toStrictEqual({
      outcome: "refused",
      code: "INVALID_VIGIL_MODE",
      detail: `VIGIL_MODE "TURBO" is not one of ${OPERATING_MODES.join(", ")}`,
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

  it("refuses a missing DATABASE_URL even when VIGIL_MODE itself is unparseable, so the first refusal is the config it read first", () => {
    const result = loadTradingConfig({ VIGIL_MODE: "TURBO" });
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
