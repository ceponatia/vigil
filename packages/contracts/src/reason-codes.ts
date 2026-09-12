import { z } from "zod";

/**
 * reason-codes.ts — the canonical `REASON_CODES` registry
 * (docs/policy.md "Reason codes"). Every rejection or non-executable
 * result vigil produces carries one of these codes as data, never a stack
 * trace surfaced to a caller (docs/resilience.md §4 "Diagnostics and
 * reason codes over exceptions").
 *
 * This module is a mirror of docs/policy.md's table, nothing more: it is
 * extended only by editing that document first, and this array must then
 * be kept in exact sync (same twenty members, same spelling). Adding a
 * code here that docs/policy.md does not define — or vice versa — is a
 * documentation/code drift bug this file's own test guards against as far
 * as a unit test can: it can prove the registry is internally consistent
 * (no duplicates, non-empty, everything parses) but cannot read the
 * Markdown table itself, so the claim that these twenty names are the
 * exact set docs/policy.md defines is the planned `scripts/check-docs.mjs`
 * section-citation check's job (`pnpm lint:docs`), not this test file's.
 */
export const REASON_CODES = [
  "STALE_QUOTE",
  "OUTSIDE_ENTRY_ZONE",
  "MINIMUM_NOTIONAL",
  "INSUFFICIENT_NET_EDGE",
  "EXPOSURE_LIMIT",
  "YIELD_LOCKED",
  "RESEARCH_EXPIRED",
  "THESIS_INVALIDATED",
  "ACCOUNT_UNRECONCILED",
  "PROTECTION_UNAVAILABLE",
  "OPERATING_BUDGET_EXHAUSTED",
  "WRONG_CHAIN",
  "UNAPPROVED_ASSET",
  "UNAPPROVED_RECIPIENT",
  "UNAPPROVED_CONTRACT",
  "ALLOWANCE_POLICY_VIOLATION",
  "SIMULATION_FAILED",
  "INSUFFICIENT_GAS_RESERVE",
  "TRANSACTION_UNRESOLVED",
  "ROUTE_UNAVAILABLE",
] as const;

export const reasonCodeSchema = z.enum(REASON_CODES);

export type ReasonCode = z.infer<typeof reasonCodeSchema>;
