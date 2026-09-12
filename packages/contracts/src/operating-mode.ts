import { z } from "zod";

/**
 * The complete operating-mode vocabulary (docs/policy.md "Operating
 * modes"). Parsing a value against this schema only proves it names one
 * of these four modes — it grants no authority. In particular, parsing
 * "LIVE" here does not enable LIVE: LIVE sits behind an owner-controlled
 * capability gate (docs/policy.md) and is never opened by an environment
 * variable or config value alone.
 */
export const OPERATING_MODES = ["PAPER", "SHADOW", "LIVE", "PAUSED"] as const;

export const operatingModeSchema = z.enum(OPERATING_MODES);

export type OperatingMode = z.infer<typeof operatingModeSchema>;
