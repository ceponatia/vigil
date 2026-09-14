import { OPERATING_MODES, operatingModeSchema } from "@vigil/contracts";
import type { OperatingMode } from "@vigil/contracts";
import { z } from "zod";

/**
 * env.ts — the ONLY module in apps/control that reads `process.env`
 * (docs/architecture.md "Configuration and secrets"; `apps/control/README.md`
 * "What it never holds"). Every other module in this app receives
 * configuration as a plain argument, so a stray `process.env` read anywhere
 * else in the dashboard is a bug this module's exclusivity makes easy to
 * grep for.
 *
 * `VIGIL_MODE` and `DATABASE_URL` are the only two variables this slice
 * reads. Neither an invalid nor a missing value ever throws: both come back
 * as a `ConfigResult` the layout renders as a full-page blocking error
 * (docs/resilience.md §1 "Fail closed on financial authority" — a dashboard
 * that renders empty-but-green over a bad config is a worse failure than
 * one that stops and says why).
 */

const databaseUrlSchema = z.string().trim().min(1, "DATABASE_URL must not be empty");

/**
 * A `process.env`-shaped source, named without referencing the global
 * `NodeJS` namespace's `ProcessEnv` type: `apps/control`'s Next-augmented
 * `tsconfig.json` makes that type's `NODE_ENV` a required property, which a
 * plain test object literal has no reason to carry, and
 * `js.configs.recommended`'s `no-undef` does not know that namespace exists
 * at all. A string index signature is what `env.VIGIL_MODE` etc. actually
 * need, and `process.env` itself satisfies it.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export type ControlConfig = {
  readonly mode: OperatingMode;
  readonly databaseUrl: string;
};

export type ConfigErrorCode = "INVALID_VIGIL_MODE" | "MISSING_DATABASE_URL";

export type ConfigResult =
  | { readonly outcome: "ok"; readonly config: ControlConfig }
  | { readonly outcome: "error"; readonly code: ConfigErrorCode; readonly detail: string };

/**
 * `env` defaults to `process.env` so every real call site reads the actual
 * environment while a test can hand this a plain object instead — still the
 * only function in the module that ever touches it.
 */
export function loadControlConfig(env: EnvSource = process.env): ConfigResult {
  const rawMode = env.VIGIL_MODE ?? "PAPER";
  const parsedMode = operatingModeSchema.safeParse(rawMode);
  if (!parsedMode.success) {
    return {
      outcome: "error",
      code: "INVALID_VIGIL_MODE",
      detail: `VIGIL_MODE "${rawMode}" is not one of ${OPERATING_MODES.join(", ")}`,
    };
  }

  const parsedUrl = databaseUrlSchema.safeParse(env.DATABASE_URL ?? "");
  if (!parsedUrl.success) {
    return {
      outcome: "error",
      code: "MISSING_DATABASE_URL",
      detail: "DATABASE_URL is not set; the dashboard has no database to read",
    };
  }

  return { outcome: "ok", config: { mode: parsedMode.data, databaseUrl: parsedUrl.data } };
}
