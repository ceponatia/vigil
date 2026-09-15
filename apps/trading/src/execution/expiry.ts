import { expireReservation, loadExpiredReservations, EXPIRED_HOLD_SCAN_LIMIT } from "@vigil/db";
import type { ExpiredHold, ExpiredHoldCursor, ReservationTransitionResult, VigilDatabase } from "@vigil/db";

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
 *
 * ## Why one pass pages
 *
 * A refused hold stays `active` with an `expires_at` in the past, so it is
 * offered again by every later scan — and, being the oldest, at the head of
 * every page. The permanently-refused ones are exactly those behind a live
 * or `UNKNOWN` attempt, which resolve only through reconciliation. Take one
 * page per tick and, once a page's worth of those accumulate, no releasable
 * hold behind them is ever examined again: `expired` reads 0 every tick and
 * nothing says why. A pass therefore walks pages within the tick, carrying a
 * cursor past what it could not end, up to a bounded page budget — and
 * reports `truncated` when it runs out of budget rather than out of holds.
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
  /**
   * Base units returned to `available`, **per asset**. Never one total: base
   * units are only meaningful beside the scale that interprets them, so
   * adding a 6-decimal stablecoin's units to an 18-decimal token's produces
   * a number that is not a quantity of anything (`AGENTS.md`, "Money is
   * never floating point"; the same rule that forbids a bare ticker).
   */
  readonly releasedByAsset: ReadonlyMap<string, bigint>;
  /** Holds a previous sweep had already ended; nothing was written for these. */
  readonly alreadyExpired: number;
  /** Holds deliberately left standing, each with the reason. */
  readonly refusals: readonly SweepRefusal[];
  /**
   * The pass hit its page budget with holds still unexamined. A backlog
   * being drained across ticks is ordinary; one that stays truncated while
   * `expired` stays 0 is the shape of a sweep that cannot get past its own
   * refusals, which is why it is reported rather than inferred.
   */
  readonly truncated: boolean;
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
  releasedByAsset: new Map(),
  alreadyExpired: 0,
  refusals: [],
  truncated: false,
};

/**
 * Pages one tick may walk. The page size is the store's own
 * `EXPIRED_HOLD_SCAN_LIMIT`, so this bounds a pass at 5,000 holds — far
 * beyond any backlog one owner's capital produces, and finite, so a tick
 * cannot run unbounded on the money path.
 */
export const MAX_SCAN_PAGES_PER_SWEEP = 25;

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
  const entryIdFor = params.entryIdFor ?? expiryEntryIdFor;
  const refusals: SweepRefusal[] = [];
  const releasedByAsset = new Map<string, bigint>();
  let examined = 0;
  let expired = 0;
  let alreadyExpired = 0;
  let truncated = false;
  let cursor: ExpiredHoldCursor | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES_PER_SWEEP; page += 1) {
    const scan =
      cursor === undefined
        ? await loadExpiredReservations(db, { asOf: params.asOf })
        : await loadExpiredReservations(db, { asOf: params.asOf, after: cursor });
    if (scan.outcome === "refused") {
      return {
        ...EMPTY_SUMMARY,
        refusals: [{ reservationId: "-", intentId: "-", code: scan.code, detail: scan.detail }],
      };
    }

    for (const hold of scan.holds) {
      examined += 1;
      const result: ReservationTransitionResult = await expireReservation(db, {
        intentId: hold.intentId,
        reservationId: hold.reservationId,
        entryId: entryIdFor(hold),
        occurredAt: hold.expiresAt,
        recordedAt: params.asOf,
        asOf: params.asOf,
      });

      if (result.outcome === "transitioned") {
        expired += 1;
        releasedByAsset.set(hold.assetId, (releasedByAsset.get(hold.assetId) ?? 0n) + result.releasedBase);
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

    const last = scan.holds.at(-1);
    // A short page is the end of the backlog. A full one is not, whatever
    // happened to the holds on it: the ones this pass ended have left the
    // result set, and the ones it refused are still at the front of it.
    if (last === undefined || scan.holds.length < EXPIRED_HOLD_SCAN_LIMIT) {
      return { examined, expired, releasedByAsset, alreadyExpired, refusals, truncated: false };
    }
    cursor = { expiresAt: last.expiresAt, reservationId: last.reservationId };
    truncated = page === MAX_SCAN_PAGES_PER_SWEEP - 1;
  }

  return { examined, expired, releasedByAsset, alreadyExpired, refusals, truncated };
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

  /**
   * One pass, and the reporting of it. `async`, so a `sweep` that throws
   * synchronously rather than returning a rejected promise is caught here
   * like any other failure; `finally` clears the latch on every path,
   * including a logger that throws while reporting.
   */
  const runPass = async (asOf: string): Promise<void> => {
    try {
      const summary = await sweep(params.db, { asOf });

      for (const refusal of summary.refusals) {
        // Debug: a hold left standing behind a live attempt is the sweep
        // working, not failing.
        params.logger.debug(
          { reservationId: refusal.reservationId, intentId: refusal.intentId, code: refusal.code },
          "reservation left standing by the expiry sweep",
        );
      }

      if (summary.expired > 0 || summary.refusals.length > 0) {
        // Counts only. The amounts released are balance-like figures and
        // never reach a log line (`docs/resilience.md` §10). `refused` is
        // here rather than left to the per-hold debug lines because a sweep
        // that refuses everything and ends nothing is indistinguishable, at
        // this level, from one with nothing to do.
        params.logger.info(
          {
            examined: summary.examined,
            expired: summary.expired,
            alreadyExpired: summary.alreadyExpired,
            refused: summary.refusals.length,
          },
          "reservation expiry sweep pass",
        );
      }

      if (summary.truncated) {
        params.logger.warn(
          { examined: summary.examined, expired: summary.expired, refused: summary.refusals.length },
          "reservation expiry sweep hit its page budget with holds still unexamined",
        );
      }
    } catch (error: unknown) {
      params.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "reservation expiry sweep failed",
      );
    } finally {
      running = false;
    }
  };

  const tick = (): void => {
    if (running) {
      params.logger.debug({}, "reservation expiry sweep still running; skipping this tick");
      return;
    }
    running = true;

    try {
      void runPass(params.now()).catch(() => {
        // Only reachable if the logger itself threw while reporting a
        // failure. `runPass`'s `finally` has already cleared the latch;
        // clearing it again is harmless, and what this stops is an unhandled
        // rejection escaping the timer callback.
        running = false;
      });
    } catch (error: unknown) {
      // `params.now()` throwing, which happens before `runPass` exists to
      // catch anything. Without this the latch stays set and every later
      // tick is skipped — the loop stops for good, and silently.
      running = false;
      params.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "reservation expiry sweep could not start",
      );
    }
  };

  tick();
  const timer = setInterval(tick, params.intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
