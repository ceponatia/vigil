import { expireReservation, loadExpiredReservations } from "@vigil/db";
import type { ExpiredHold, ReservationTransitionResult, VigilDatabase } from "@vigil/db";

/**
 * expiry.ts — the sweep that stops an abandoned hold from holding capital
 * forever.
 *
 * A reservation is written before anything acts on it (`docs/resilience.md`
 * §9) and is unwound by whatever consumes it. Nothing consumes the hold of
 * an intent that was cancelled before it ever filled: `settle.ts` posts
 * nothing for a terminal attempt that spent nothing — deliberately, because
 * that authorization is still open to a versioned retry — so the hold sits
 * `active` until something notices that its window has closed. Its
 * `expires_at` is the intent's own `valid_until`, and after that instant it
 * authorizes nothing at all. This is what notices.
 *
 * ## Why a periodic sweep rather than an opportunistic one
 *
 * The alternative considered was sweeping on read, inside
 * `loadActiveReservations`. It was rejected on three counts, any one of which
 * is decisive:
 *
 * 1. **It does not meet the requirement.** A hold released only when someone
 *    asks about that asset is a hold that persists indefinitely when nobody
 *    asks — and an intent cancelled before it filled is exactly the case
 *    where nothing asks again.
 * 2. **A read would post journal entries.** Every entry id in this domain is
 *    injected so a replay is byte-identical (`SettlementIdentities`), and
 *    every instant is the caller's. A projection read that minted ids and
 *    read a clock would put a money-moving write behind a function whose
 *    callers — a dashboard, a test assertion — have no idea they are
 *    authorizing one.
 * 3. **It would be scoped to one asset.** `loadActiveReservations` takes an
 *    asset id; an abandoned hold on an asset nothing trades any more is
 *    precisely the one that would never be swept.
 *
 * What a periodic sweep costs is a timer, and that is all it is: no
 * scheduler service, no queue, no new process. It is the same shape as the
 * heartbeat loop beside it — `setInterval`, a fail-soft tick, a `stop()` the
 * shutdown path calls.
 *
 * ## What the sweep may and may not release
 *
 * It decides almost nothing. `loadExpiredReservations` returns candidates by
 * `(state, expires_at)`; whether each may actually be handed back is decided
 * by `expireReservation` inside the transaction that would do it, against
 * rows this process cannot have read stale. In particular a hold behind a
 * live attempt — `UNKNOWN` included — is refused and left standing, because
 * an unresolved order releases nothing and resolves only through
 * reconciliation (`docs/resilience.md` §3). A sweep that "cleaned up" such a
 * hold would hand the same capital to a second intent while the venue could
 * still fill the first.
 *
 * So a refusal here is ordinary, not an incident: it is logged at debug and
 * counted, and the loop keeps running.
 */

/** The narrow logging surface this module needs; a pino `Logger` satisfies it. */
export type ExpirySweepLogger = {
  readonly debug: (detail: Record<string, unknown>, message: string) => void;
  readonly info: (detail: Record<string, unknown>, message: string) => void;
  readonly warn: (detail: Record<string, unknown>, message: string) => void;
};

/** One hold the sweep could not end, and the store's reason. */
export type SweepRefusal = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly code: string;
  readonly detail: string;
};

export type ExpirySweepSummary = {
  /** Holds whose window had closed at `asOf`. */
  readonly examined: number;
  /** Holds handed back to `available` by this sweep. */
  readonly expired: number;
  /** Base units returned to `available`, summed across every asset touched. */
  readonly releasedBase: bigint;
  /** Holds a previous sweep had already ended; nothing was written for these. */
  readonly alreadyExpired: number;
  /** Holds deliberately left standing, each with the reason. */
  readonly refusals: readonly SweepRefusal[];
};

export type SweepExpiredReservationsParams = {
  /** ISO-8601 UTC; the instant this sweep is asking about. */
  readonly asOf: string;
  /**
   * The journal entry id each release posts under. Deterministic by default
   * — derived from the reservation's own id — so a replay of a sweep writes
   * the same entry id it wrote the first time.
   */
  readonly entryIdFor?: (hold: ExpiredHold) => string;
};

/** The default, deterministic entry id: one expiry posting per reservation, named after it. */
export function expiryEntryIdFor(hold: ExpiredHold): string {
  return `expire-${hold.reservationId}`;
}

const EMPTY_SUMMARY: ExpirySweepSummary = {
  examined: 0,
  expired: 0,
  releasedBase: 0n,
  alreadyExpired: 0,
  refusals: [],
};

/**
 * One pass: find the holds whose window has closed and end the ones that may
 * be ended.
 *
 * Sequential rather than concurrent on purpose. Every release touches the
 * same two `ledger_balances` rows per asset, so a fan-out would mostly queue
 * on those row locks anyway, and a sweep is not on any latency path.
 *
 * A pass is bounded by `EXPIRED_HOLD_SCAN_LIMIT`, which the store applies to
 * every scan whether or not a page size is asked for. This layer names no
 * page size of its own: a smaller one would only slow the backlog draining
 * across ticks, and an optional nobody passes is untested surface on a
 * module that moves money.
 *
 * `occurredAt` is the hold's own `expires_at`, not `asOf`: the economic event
 * is the window closing, which happened when it happened. `asOf` is when this
 * application wrote it down. A sweep that ran late therefore records the same
 * `occurred_at` it would have recorded on time.
 */
export async function sweepExpiredReservations(
  db: VigilDatabase,
  params: SweepExpiredReservationsParams,
): Promise<ExpirySweepSummary> {
  const scan = await loadExpiredReservations(db, { asOf: params.asOf });
  if (scan.outcome === "refused") {
    return {
      ...EMPTY_SUMMARY,
      refusals: [{ reservationId: "-", intentId: "-", code: scan.code, detail: scan.detail }],
    };
  }

  const entryIdFor = params.entryIdFor ?? expiryEntryIdFor;
  const refusals: SweepRefusal[] = [];
  let expired = 0;
  let alreadyExpired = 0;
  let releasedBase = 0n;

  for (const hold of scan.holds) {
    const result: ReservationTransitionResult = await expireReservation(db, {
      intentId: hold.intentId,
      entryId: entryIdFor(hold),
      occurredAt: hold.expiresAt,
      recordedAt: params.asOf,
      asOf: params.asOf,
    });

    if (result.outcome === "transitioned") {
      expired += 1;
      releasedBase += result.releasedBase;
    } else if (result.outcome === "noop") {
      alreadyExpired += 1;
    } else {
      refusals.push({
        reservationId: hold.reservationId,
        intentId: hold.intentId,
        code: result.code,
        detail: result.detail,
      });
    }
  }

  return { examined: scan.holds.length, expired, releasedBase, alreadyExpired, refusals };
}

export type StartReservationExpirySweepParams = {
  readonly db: VigilDatabase;
  readonly logger: ExpirySweepLogger;
  readonly intervalMs: number;
  /** Reads the wall clock; injected so the loop itself holds no clock. */
  readonly now: () => string;
  /**
   * Defaults to `sweepExpiredReservations`. Overridable so a test can drive
   * the loop's fail-soft behavior without a database; the loop never depends
   * on the override existing.
   */
  readonly sweep?: (db: VigilDatabase, params: SweepExpiredReservationsParams) => Promise<ExpirySweepSummary>;
};

export type ReservationExpirySweep = {
  readonly stop: () => void;
};

/**
 * Sweeps once immediately, then every `intervalMs`.
 *
 * A failed sweep is logged and the loop keeps running, for the same reason
 * the heartbeat loop survives a refused write: a process that could still
 * protect open positions does not exit because a housekeeping pass could not
 * reach the database (`docs/resilience.md` §2). Nothing is released on a
 * failure — the transaction that would have done it rolled back — so the
 * failure mode is a hold that stays held, which is the conservative
 * direction.
 *
 * Overlap is prevented by a flag rather than by timing: a pass that outruns
 * the interval must not have a second pass start behind it, or two sweeps
 * would queue on the same row locks and the backlog would grow.
 */
export function startReservationExpirySweep(params: StartReservationExpirySweepParams): ReservationExpirySweep {
  const sweep = params.sweep ?? sweepExpiredReservations;
  let running = false;

  const tick = (): void => {
    if (running) {
      params.logger.debug({}, "reservation expiry sweep still running; skipping this tick");
      return;
    }
    const asOf = params.now();
    running = true;

    sweep(params.db, { asOf })
      .then((summary) => {
        for (const refusal of summary.refusals) {
          // Debug, not warn: a hold left standing behind a live attempt is
          // the sweep working, not failing.
          params.logger.debug(
            { reservationId: refusal.reservationId, intentId: refusal.intentId, code: refusal.code },
            "reservation left standing by the expiry sweep",
          );
        }
        if (summary.expired > 0) {
          // The released figure is a balance-like amount, so it is not
          // logged (`docs/resilience.md` §10) — only how many holds ended.
          params.logger.info(
            { expired: summary.expired, examined: summary.examined },
            "expired reservations released",
          );
        }
      })
      .catch((error: unknown) => {
        params.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "reservation expiry sweep failed",
        );
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, params.intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
