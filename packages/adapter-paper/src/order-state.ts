import { z } from "zod";

/**
 * order-state.ts — the Exchange order lifecycle from
 * `docs/architecture.md` "Execution lifecycles", transcribed as a
 * transition table so that "no transition outside the diagram" is a value
 * this package checks rather than a comment nobody runs.
 *
 * The diagram, verbatim:
 *
 * ```text
 * PROPOSED -> VALIDATED -> RESERVED -> SUBMITTING -> ACKNOWLEDGED
 *                                             \-> UNKNOWN
 * ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED
 * ACKNOWLEDGED / PARTIALLY_FILLED -> CANCEL_PENDING -> CANCELED
 * SUBMITTING / ACKNOWLEDGED -> REJECTED or EXPIRED only when confirmed
 * UNKNOWN -> reconciliation -> confirmed exchange state
 * ```
 *
 * This table IS the contract, so it is pinned literally rather than
 * derived (`.agents/skills/vigil-testing`: pin a literal only where the
 * literal is the contract). Three readings of the diagram are recorded
 * here because they are decisions, not transcription:
 *
 * 1. **`ACKNOWLEDGED -> FILLED` is legal.** The diagram's
 *    `ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED` enumerates the stages of
 *    the fill path; it is not a requirement that a single execution which
 *    consumes the whole quantity must first be recorded as a partial fill.
 *    Forcing a spurious `PARTIALLY_FILLED` would write a state the order
 *    was never in into a record the ledger reads, which is the more
 *    dangerous of the two readings. A repeat partial execution is NOT a
 *    self-transition: the order stays `PARTIALLY_FILLED` and only its fill
 *    totals move, so no `PARTIALLY_FILLED -> PARTIALLY_FILLED` edge
 *    exists and none is recorded in an order's history.
 * 2. **`UNKNOWN` resolves only to a confirmed venue state.** "UNKNOWN ->
 *    reconciliation -> confirmed exchange state" is expanded to the six
 *    states a venue can actually confirm. `UNKNOWN -> CANCEL_PENDING` is
 *    absent on purpose: `CANCEL_PENDING` is itself unconfirmed, so it can
 *    never be the answer reconciliation returns.
 * 3. **A cancellation timeout does not move the order to `UNKNOWN`.** The
 *    diagram gives `UNKNOWN` exactly one inbound edge, from `SUBMITTING`.
 *    `CANCEL_PENDING` is the lifecycle's own limbo for an unconfirmed
 *    cancellation and `docs/resilience.md` §3's rule holds there
 *    identically: the cancellation is never assumed to have succeeded or
 *    failed, and only reconciliation moves it to `CANCELED`. The
 *    cancellation *attempt* reports an `UNKNOWN` outcome; the *order*
 *    stays `CANCEL_PENDING`.
 *
 * Transitions the diagram does not draw are therefore absent here, and
 * this package refuses rather than inventing them. Two are worth naming
 * because a real venue can produce them and a future slice will have to
 * ask the owner for a documented edge before simulating them: a fill that
 * lands after a cancel request (`CANCEL_PENDING -> PARTIALLY_FILLED` or
 * `-> FILLED`), and a partially filled resting order that the venue
 * expires (`PARTIALLY_FILLED -> EXPIRED`).
 *
 * Where this belongs eventually: the state vocabulary is the execution
 * domain's, not this adapter's. It lives here because `adapter-paper` is
 * the only adapter that exists and nothing else may import an `adapter-*`
 * package. The day a second adapter lands, this module is the thing to
 * promote into `@vigil/contracts` — the same shape of duplication issue
 * #20 already tracks for scaled-decimal arithmetic.
 */

export const ORDER_STATES = [
  "PROPOSED",
  "VALIDATED",
  "RESERVED",
  "SUBMITTING",
  "ACKNOWLEDGED",
  "UNKNOWN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
] as const;

export const orderStateSchema = z.enum(ORDER_STATES);

export type OrderState = z.infer<typeof orderStateSchema>;

/**
 * Every legal transition, keyed by origin state. A state whose list is
 * empty is terminal: nothing leaves it, ever, including a "correction".
 */
export const ORDER_STATE_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  PROPOSED: ["VALIDATED"],
  VALIDATED: ["RESERVED"],
  RESERVED: ["SUBMITTING"],
  SUBMITTING: ["ACKNOWLEDGED", "UNKNOWN", "REJECTED", "EXPIRED"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "REJECTED", "EXPIRED"],
  UNKNOWN: ["ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXPIRED"],
  PARTIALLY_FILLED: ["FILLED", "CANCEL_PENDING"],
  CANCEL_PENDING: ["CANCELED"],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
};

/**
 * The states no transition leaves. Derived from the table rather than
 * listed again, so a table edit cannot leave a second list stale.
 */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = ORDER_STATES.filter(
  (state) => ORDER_STATE_TRANSITIONS[state].length === 0,
);

/**
 * The states reconciliation may resolve an `UNKNOWN` order to — the venue's
 * own confirmed answers. Derived from the table for the same reason.
 */
export const CONFIRMED_VENUE_STATES: readonly OrderState[] = ORDER_STATE_TRANSITIONS.UNKNOWN;

/**
 * The states in which the venue holds a live order that can still fill:
 * the only states `pollOrder` advances and the only states a cancellation
 * may be requested from.
 */
export const LIVE_ORDER_STATES: readonly OrderState[] = ["ACKNOWLEDGED", "PARTIALLY_FILLED"];

export function isTerminalOrderState(state: OrderState): boolean {
  return TERMINAL_ORDER_STATES.includes(state);
}

export function isLiveOrderState(state: OrderState): boolean {
  return LIVE_ORDER_STATES.includes(state);
}

/**
 * Whether `from -> to` appears in the diagram. A state is never "legal to
 * itself": staying put is not a transition, and recording one would put a
 * state change into an order's history that never happened.
 */
export function isLegalOrderTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) {
    return false;
  }
  return ORDER_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The shortest sequence of documented transitions that walks `from` to `to`,
 * as the states to move through (excluding `from`, including `to`), or `null`
 * when the lifecycle draws no route at all. An empty array means the two are
 * already the same state and nothing should be recorded.
 *
 * This exists because the venue can legitimately move two steps while the
 * caller's view moves none — a venue-initiated cancellation takes a resting
 * order `ACKNOWLEDGED -> CANCEL_PENDING -> CANCELED` in one go, and a caller
 * that only ever applies a single direct edge has no way to catch up. Before
 * this, such an order was wedged: no operation could advance it, its reserved
 * capital was never released, and its fills at the venue were unobservable.
 *
 * Walking a path is not inventing one. Every state the caller passes through
 * is a state the venue actually passed through, every edge comes out of the
 * table, and the order's history records each one, so a reader can see the
 * route rather than a jump. Breadth-first over the table in registry order,
 * so the route chosen for a given pair is the same on every run and a direct
 * edge always wins over a longer detour.
 */
export function orderTransitionPath(from: OrderState, to: OrderState): readonly OrderState[] | null {
  if (from === to) {
    return [];
  }

  const cameFrom = new Map<OrderState, OrderState>();
  const seen = new Set<OrderState>([from]);
  const queue: OrderState[] = [from];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const next of ORDER_STATE_TRANSITIONS[current]) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      cameFrom.set(next, current);
      if (next === to) {
        const path: OrderState[] = [];
        let step: OrderState | undefined = to;
        while (step !== undefined && step !== from) {
          path.unshift(step);
          step = cameFrom.get(step);
        }
        return path;
      }
      queue.push(next);
    }
  }

  return null;
}
