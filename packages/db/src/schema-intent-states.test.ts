import { describe, expect, it } from "vitest";

import {
  executionAttemptStateEnum,
  LIVE_EXECUTION_ATTEMPT_STATES,
  TERMINAL_EXECUTION_ATTEMPT_STATES,
} from "./schema/intents";

// Lives beside src/, NOT under src/schema/: drizzle.config.ts globs
// `packages/db/src/schema/*.ts`, so a test file in that directory is loaded
// as if it were a schema module — which makes `pnpm db:generate` fail
// outright on `vitest` being require()d from a CommonJS bin. The same note
// stands at the top of `schema-invariants.int.test.ts`, for the same reason.

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
 * Dividing the enum is not enough on its own, though, and the gap is the
 * dangerous one: a state that MOVES from one list to the other keeps the
 * division intact and passes the first case below. Nothing else in the
 * repository would notice. The suites that prove an UNKNOWN attempt blocks a
 * retry are proving the database index, whose state list is frozen into
 * `drizzle/0009_approved_intents_economics_attempts_and_outbox.sql` and would
 * stay green; `loadUnresolvedAttempts` would simply stop returning the lost
 * acknowledgement it exists for. So the second case pins the states a durable
 * rule names outright, by name.
 *
 * No database is needed to hold these lists to the enum or to the rule, so
 * this is a unit test: the cheapest layer that owns the claim.
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

  it("keeps the two states docs/resilience.md §3 calls unresolved on the live side of that division — catches UNKNOWN or CANCEL_PENDING reclassified as settled, which divides the enum just as cleanly, passes every other suite, and silently empties the read a restart depends on of the exact attempts whose money is in doubt", () => {
    // "A submission timeout and broadcast ambiguity produce the UNKNOWN
    // state… It resolves only through reconciliation" — a state, not a
    // failure, and nothing downstream re-derives that.
    expect(LIVE_EXECUTION_ATTEMPT_STATES).toContain("UNKNOWN");
    // "A cancellation timeout produces an UNKNOWN attempt result and leaves
    // the order where it already is… CANCEL_PENDING… because an unconfirmed
    // cancellation has neither taken effect nor been refused." An order in
    // that state is live at the venue and owed a chase.
    expect(LIVE_EXECUTION_ATTEMPT_STATES).toContain("CANCEL_PENDING");

    // Deliberately these two and no more. Pinning all nine would restate the
    // constant rather than check it, and would fail on a tenth state that is
    // added correctly. These are the two whose classification a durable rule
    // fixes, and the two whose reclassification costs money quietly.
  });
});
