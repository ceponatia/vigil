import { describe, expect, it } from "vitest";

import {
  executionAttemptStateEnum,
  LIVE_EXECUTION_ATTEMPT_STATES,
  TERMINAL_EXECUTION_ATTEMPT_STATES,
} from "./intents";

/**
 * The defect this file kills: a tenth execution attempt state added to the
 * enum and to neither of the two lists that divide it.
 *
 * Nothing about such a state looks wrong. The column accepts it, the
 * lifecycle trigger has no opinion on it, and every suite that names states
 * individually keeps passing. What it silently leaves out is every predicate
 * built on one of these lists: `execution_attempts_intent_id_live_key`, which
 * would stop refusing a second attempt while one in the new state is open,
 * and `loadUnresolvedAttempts`, which would stop returning attempts in it —
 * so an attempt whose money is in doubt would be invisible to the read a
 * restart depends on, and no test of that read would fail.
 *
 * No database is needed to hold the two lists to the enum, so this is a unit
 * test: the cheapest layer that owns the claim.
 */
describe("execution attempt states", () => {
  it("accounts for every state in the enum as either live or terminal, exactly once — catches a state added to the lifecycle and to neither list, which drops silently out of every read and index whose predicate is one of the two", () => {
    const divided = [...LIVE_EXECUTION_ATTEMPT_STATES, ...TERMINAL_EXECUTION_ATTEMPT_STATES].sort();

    // Sorted whole-array equality rather than a membership check in one
    // direction: it catches the state that is in neither list, and equally
    // the state that ends up in both, which would make "live" and
    // "terminal" overlap.
    expect(divided).toEqual([...executionAttemptStateEnum.enumValues].sort());
  });
});
