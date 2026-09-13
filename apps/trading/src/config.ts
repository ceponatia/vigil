import { operatingModeSchema } from "@vigil/contracts";
import type { OperatingMode } from "@vigil/contracts";
import { z } from "zod";

/**
 * config.ts — the ONLY module in apps/trading that reads `process.env`
 * (docs/architecture.md "Configuration and secrets"). Everything else in
 * this runtime takes configuration as a plain argument.
 *
 * This slice (BOOT-07) ships nothing but a heartbeat loop: no market
 * engine, no strategy engine, no execution domain. SHADOW needs the full
 * research-to-proposal pipeline and LIVE needs the capability gate
 * (`apps/trading/README.md` "Operating modes") — neither exists yet, so
 * both refuse to start here with a diagnostic instead of starting a
 * runtime that cannot do what its own mode claims. PAPER and PAUSED are
 * the only modes this build can actually enter.
 */

const STARTABLE_MODES = ["PAPER", "PAUSED"] as const;
export type StartableMode = (typeof STARTABLE_MODES)[number];

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = (typeof LOG_LEVELS)[number];

export type TradingConfig = {
  readonly databaseUrl: string;
  readonly mode: StartableMode;
  readonly logLevel: LogLevel;
};

export type ConfigRefusalCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_VIGIL_MODE"
  | "MODE_NOT_STARTABLE"
  | "INVALID_LOG_LEVEL";

export type ConfigResult =
  | { readonly outcome: "ok"; readonly config: TradingConfig }
  | { readonly outcome: "refused"; readonly code: ConfigRefusalCode; readonly detail: string };

function isStartableMode(mode: OperatingMode): mode is StartableMode {
  return (STARTABLE_MODES as readonly OperatingMode[]).includes(mode);
}

/**
 * `env` defaults to `process.env` so every real call site reads the actual
 * environment while a test can hand this a plain object instead — still
 * the only function in the module that ever touches it.
 */
export function loadTradingConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (databaseUrl === "") {
    return { outcome: "refused", code: "MISSING_DATABASE_URL", detail: "DATABASE_URL is not set" };
  }

  const rawMode = env.VIGIL_MODE ?? "PAPER";
  const parsedMode = operatingModeSchema.safeParse(rawMode);
  if (!parsedMode.success) {
    return {
      outcome: "refused",
      code: "INVALID_VIGIL_MODE",
      detail: `VIGIL_MODE "${rawMode}" is not one of PAPER, SHADOW, LIVE, PAUSED`,
    };
  }

  if (!isStartableMode(parsedMode.data)) {
    return {
      outcome: "refused",
      code: "MODE_NOT_STARTABLE",
      detail: `this build has no market/strategy/execution pipeline yet, so it cannot enter ${parsedMode.data} (apps/trading/README.md "Operating modes")`,
    };
  }

  const rawLogLevel = env.LOG_LEVEL ?? "info";
  const parsedLogLevel = logLevelSchema.safeParse(rawLogLevel);
  if (!parsedLogLevel.success) {
    return {
      outcome: "refused",
      code: "INVALID_LOG_LEVEL",
      detail: `LOG_LEVEL "${rawLogLevel}" is not a valid pino level`,
    };
  }

  return { outcome: "ok", config: { databaseUrl, mode: parsedMode.data, logLevel: parsedLogLevel.data } };
}
