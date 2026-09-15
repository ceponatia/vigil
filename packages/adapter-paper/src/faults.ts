import type { DecimalString } from "@vigil/contracts";

/**
 * faults.ts — the injection surface. Everything the simulated venue does
 * that a caller might otherwise expect to be "realistic" is declared here
 * instead, per client order id, so a scenario is written rather than
 * waited for.
 *
 * This is the shape issue #35's fault-injection suite drives
 * (`docs/testing.md` "Idempotency and recovery"), so it is designed to be
 * read as a scenario, not to model a matching engine. Nothing here is
 * probabilistic and nothing here consults a clock: a behavior plus the
 * `now` values a test passes in fully determine what the venue does.
 *
 * The one thing a behavior deliberately cannot set is an execution PRICE.
 * Price comes from the quote the caller submits against, adjusted by the
 * exchange's configured slippage cap and nothing else. A test that could
 * name an arbitrary fill price could drive a fill outside the intent's
 * approved `maxSpend`/`minAcceptableReceipt` envelope, and the whole point
 * of the submission-time envelope check is that no execution the venue
 * produces can land outside it.
 */

export type SubmissionBehavior =
  /** The venue accepts and acknowledges; the caller observes the acknowledgement. */
  | { readonly kind: "ACKNOWLEDGE" }
  /**
   * The submission response is lost. `venueAccepted` decides which of the
   * two very different situations this is, and the caller cannot tell them
   * apart — which is exactly the point of UNKNOWN:
   *
   * - `true`: the venue accepted the order and will go on working it. This
   *   is the crash-shaped gap from `docs/testing.md` — "crash after
   *   exchange acceptance but before local acknowledgement".
   * - `false`: the venue never saw it. Nothing is working, and an
   *   authoritative reconciliation read will hold no record of it.
   */
  | { readonly kind: "TIMEOUT"; readonly venueAccepted: boolean }
  /** The venue confirms a rejection. Only a confirmation reaches REJECTED. */
  | { readonly kind: "REJECT"; readonly detail: string }
  /** The venue confirms an expiry. Only a confirmation reaches EXPIRED. */
  | { readonly kind: "EXPIRE"; readonly detail: string };

export type ExecutionStep = {
  readonly quantity: DecimalString;
  /** Milliseconds after acceptance at which this execution becomes visible. */
  readonly afterMs: number;
};

export type ExecutionBehavior =
  /** Acknowledged and resting: no execution, ever. */
  | { readonly kind: "NONE" }
  /** One execution for the whole quantity. */
  | { readonly kind: "FULL"; readonly afterMs: number }
  /**
   * Exactly these executions, in this order. Their quantities may sum to
   * less than the order's — that is a partial fill that then rests, which
   * is what a cancellation-after-partial-fill scenario needs. They may
   * never sum to more: a venue cannot fill more than it was asked for, and
   * a behavior that tries to is a bug in the scenario, not a fault to
   * simulate.
   */
  | { readonly kind: "STEPS"; readonly steps: readonly ExecutionStep[] }
  /**
   * `stepCount` partial executions, `intervalMs` apart, whose quantities
   * are derived from the exchange's seed and the client order id and always
   * sum to the whole order exactly. The same seed and the same client order
   * id always produce the same split, whatever else the exchange did first.
   */
  | { readonly kind: "SEEDED"; readonly stepCount: number; readonly intervalMs: number };

export type CancellationBehavior =
  /** The venue cancels and the caller observes the confirmation. */
  | { readonly kind: "CONFIRM" }
  /**
   * The venue cancels and the confirmation is lost. The order stays
   * `CANCEL_PENDING` for the caller and only reconciliation resolves it —
   * `docs/resilience.md` §3's cancellation timeout, which is never assumed
   * to have succeeded and never assumed to have failed.
   */
  | { readonly kind: "TIMEOUT" };

/**
 * Something the VENUE does to a resting order on its own, with no request
 * from the caller. These are the edges the lifecycle draws out of
 * `ACKNOWLEDGED` that no caller action produces, and a caller sitting at
 * `UNKNOWN` learns about them only by reconciling.
 *
 * `EXPIRE` and `REJECT` apply only while the order is still `ACKNOWLEDGED`.
 * Once anything has filled, the lifecycle draws no edge from
 * `PARTIALLY_FILLED` to either of them, so the event is dropped rather than
 * simulated through a transition the diagram does not contain — see
 * `order-state.ts` for the two edges a real venue has that this machine
 * would need an owner ruling and a documented diagram change to gain.
 */
export type RestingBehavior =
  | { readonly kind: "NONE" }
  /** The venue expires the resting order. */
  | { readonly kind: "EXPIRE"; readonly afterMs: number; readonly detail: string }
  /** The venue rejects the order after having acknowledged it. */
  | { readonly kind: "REJECT"; readonly afterMs: number; readonly detail: string }
  /**
   * The venue cancels the order itself — a cancel-on-disconnect, a session
   * loss, an operator action at the venue. Runs through `CANCEL_PENDING` to
   * `CANCELED` exactly as a requested cancellation does, and is the only
   * way an order the caller never acknowledged can end up `CANCELED`.
   */
  | { readonly kind: "CANCEL"; readonly afterMs: number; readonly detail: string };

export type VenueBehavior = {
  readonly submission: SubmissionBehavior;
  readonly executions: ExecutionBehavior;
  readonly cancellation: CancellationBehavior;
  /** Defaults to `{ kind: "NONE" }`: a resting order just rests. */
  readonly resting?: RestingBehavior;
};

/** Acknowledge, fill the whole quantity immediately, confirm any cancellation. */
export const ACKNOWLEDGE_AND_FILL: VenueBehavior = {
  submission: { kind: "ACKNOWLEDGE" },
  executions: { kind: "FULL", afterMs: 0 },
  cancellation: { kind: "CONFIRM" },
};

/** Acknowledge and rest without filling — the order a caller then cancels. */
export const ACKNOWLEDGE_AND_REST: VenueBehavior = {
  submission: { kind: "ACKNOWLEDGE" },
  executions: { kind: "NONE" },
  cancellation: { kind: "CONFIRM" },
};

/**
 * How much of the venue a reconciliation read could actually see.
 *
 * This is the distinction that decides whether an ABSENCE means anything.
 * A `COMPLETE` read is authoritative: an order it does not list is an order
 * the venue does not hold, which is a confirmation. An `INCOMPLETE` read
 * may still be trusted for what it DOES list — a row in it is the venue's
 * own answer — but an order missing from it proves nothing, so an UNKNOWN
 * order stays UNKNOWN rather than being resolved by silence
 * (`docs/resilience.md` §1, §3).
 */
export const RECONCILIATION_COVERAGES = ["COMPLETE", "INCOMPLETE"] as const;

export type ReconciliationCoverage = (typeof RECONCILIATION_COVERAGES)[number];
