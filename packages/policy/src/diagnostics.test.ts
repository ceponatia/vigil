import { describe, expect, it } from "vitest";
import { REASON_CODES } from "@vigil/contracts";

import {
  inputRefusal,
  isPolicyReason,
  policyRefusal,
  POLICY_DIAGNOSTIC_CODES,
  POLICY_EMITTED_REASON_CODES,
} from "./diagnostics";

// Derived from the contracts registry itself, never a hand-copied list —
// the same posture packages/contracts/src/reason-codes.test.ts takes. What
// this suite owns is the relationship between this package's two
// vocabularies and the owner-approved one: that every code this package
// claims to emit is real, that it claims only a subset, and that its local
// diagnostics cannot be mistaken for policy decisions.
describe("POLICY_EMITTED_REASON_CODES", () => {
  it("contains only members of the contracts REASON_CODES registry — an invented code would reach a record looking official", () => {
    for (const code of POLICY_EMITTED_REASON_CODES) {
      expect(REASON_CODES).toContain(code);
    }
  });

  it("is a strict subset of the registry — the point of the list is to say which of the twenty THIS package raises", () => {
    expect(POLICY_EMITTED_REASON_CODES.length).toBeGreaterThan(0);
    expect(POLICY_EMITTED_REASON_CODES.length).toBeLessThan(REASON_CODES.length);
  });

  it("contains no duplicate", () => {
    expect(new Set(POLICY_EMITTED_REASON_CODES).size).toBe(POLICY_EMITTED_REASON_CODES.length);
  });

  it("names exactly the six codes this slice implements a path for, so the list cannot quietly grow past the checks that raise them", () => {
    expect([...POLICY_EMITTED_REASON_CODES].sort()).toEqual(
      [
        "ACCOUNT_UNRECONCILED",
        "EXPOSURE_LIMIT",
        "INSUFFICIENT_NET_EDGE",
        "MINIMUM_NOTIONAL",
        "OUTSIDE_ENTRY_ZONE",
        "STALE_QUOTE",
      ].sort(),
    );
  });
});

describe("POLICY_DIAGNOSTIC_CODES", () => {
  it("shares no member with the owner-approved registry — a local diagnostic that collided with a policy code could be recorded as a policy decision the owner never defined", () => {
    for (const code of POLICY_DIAGNOSTIC_CODES) {
      expect(REASON_CODES).not.toContain(code);
    }
  });

  it("contains no duplicate", () => {
    expect(new Set(POLICY_DIAGNOSTIC_CODES).size).toBe(POLICY_DIAGNOSTIC_CODES.length);
  });

  it("contains only upper-snake-case members, matching the registry's own convention", () => {
    for (const code of POLICY_DIAGNOSTIC_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("refusal constructors", () => {
  it("tags a policy decision as source 'policy' so a reader knows it came from docs/policy.md's vocabulary", () => {
    const refusal = policyRefusal("EXPOSURE_LIMIT", "cap met");
    expect(refusal.reason.source).toBe("policy");
    expect(refusal.reason.code).toBe("EXPOSURE_LIMIT");
    expect(isPolicyReason(refusal.reason)).toBe(true);
  });

  it("tags an input problem as source 'input' so it can never be filed as a policy decision about the proposal", () => {
    const refusal = inputRefusal("NON_POSITIVE_PRICE", "price was zero");
    expect(refusal.reason.source).toBe("input");
    expect(isPolicyReason(refusal.reason)).toBe(false);
  });
});
