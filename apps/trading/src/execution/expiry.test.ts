import type { VigilDatabase } from "@vigil/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expiryEntryIdFor,
  startReservationExpirySweep,
  sweepExpiredReservations,
  type ExpirySweepSummary,
  type SweepExpiredReservationsParams,
} from "./expiry";

// The defects this file kills:
//   * a sweep that runs once at startup and never again, which leaves the
//     very hold it exists to end sitting `active` for the life of the
//     process — the failure is silent, because nothing ever reports it;
//   * a failed pass taking the runtime down with it, so a housekeeping query
//     that could not reach the database stops a process that might still be
//     protecting open positions (docs/resilience.md §2);
//   * a slow pass having a second pass start behind it, so two sweeps queue
//     on the same row locks and the backlog grows instead of draining;
//   * a non-deterministic entry id, which would make a replayed sweep write
//     a different journal than the one it is replaying.

// Every loop test injects `sweep`, so this value is never dereferenced — it
// only has to satisfy the parameter's type.
const FAKE_DB = {} as unknown as VigilDatabase;

const EMPTY: ExpirySweepSummary = {
  examined: 0,
  expired: 0,
  releasedByAsset: new Map(),
  alreadyExpired: 0,
  refusals: [],
  truncated: false,
};

type RecordingLogger = {
  readonly debug: (detail: Record<string, unknown>, message: string) => void;
  readonly info: (detail: Record<string, unknown>, message: string) => void;
  readonly warn: (detail: Record<string, unknown>, message: string) => void;
};

function silentLogger(): RecordingLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

describe("expiryEntryIdFor", () => {
  it("names the posting after the reservation it ends, with nothing random in it — catches an id minted from a clock or a counter, which would make the second run of a replayed sweep write an entry the first run never wrote", () => {
    const hold = {
      reservationId: "reservation-7",
      intentId: "intent-7",
      assetId: "1337|native|VGLSTABLE|SYNTHETIC_TESTNET",
      amountBase: 5n,
      expiresAt: "2026-01-02T03:10:00.000Z",
    };

    expect(expiryEntryIdFor(hold)).toBe("expire-reservation-7");
    expect(expiryEntryIdFor(hold)).toBe(expiryEntryIdFor({ ...hold, expiresAt: "2026-05-05T05:05:00.000Z" }));
  });
});

describe("sweepExpiredReservations", () => {
  it("reports a malformed instant as a refusal in its summary instead of throwing — catches schema-legal input reaching the loop as an exception (docs/resilience.md §4)", async () => {
    const summary = await sweepExpiredReservations(FAKE_DB, { asOf: "2026-02-30T00:00:00.000Z" });

    expect(summary.expired).toBe(0);
    expect(summary.releasedByAsset.size).toBe(0);
    expect(summary.truncated).toBe(false);
    expect(summary.refusals).toHaveLength(1);
    expect(summary.refusals[0]?.code).toBe("INVALID_INSTANT");
  });
});

describe("startReservationExpirySweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps immediately and then on every interval — catches a one-shot timer, which leaves an abandoned hold held for the life of the process", async () => {
    const sweep = vi.fn(async (): Promise<ExpirySweepSummary> => EMPTY);
    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger: silentLogger(),
      intervalMs: 60_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(sweep).toHaveBeenCalledTimes(4);

    loop.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sweep).toHaveBeenCalledTimes(4);
  });

  it("asks about the instant of the tick it is on, not the one it started at — catches a clock read hoisted out of the loop, where every later pass re-asks a question about the past and sweeps nothing", async () => {
    const asked: string[] = [];
    const sweep = vi.fn(async (_db: VigilDatabase, params: SweepExpiredReservationsParams): Promise<ExpirySweepSummary> => {
      asked.push(params.asOf);
      return EMPTY;
    });
    let tick = 0;
    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger: silentLogger(),
      intervalMs: 1_000,
      now: () => {
        tick += 1;
        return `2026-01-02T03:1${String(tick)}:00.000Z`;
      },
      sweep,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    loop.stop();

    expect(asked).toEqual(["2026-01-02T03:11:00.000Z", "2026-01-02T03:12:00.000Z", "2026-01-02T03:13:00.000Z"]);
  });

  it("keeps running after a pass rejects, and logs it — catches a failed housekeeping query taking down a runtime that could still be protecting open positions", async () => {
    const logger = silentLogger();
    let calls = 0;
    const sweep = vi.fn(async (): Promise<ExpirySweepSummary> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
      return EMPTY;
    });

    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger,
      intervalMs: 1_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith({ error: "connection reset" }, "reservation expiry sweep failed");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("does not start a second pass while one is still running — catches two sweeps queueing on the same row locks, where a backlog grows instead of draining", async () => {
    let finishFirst = (): void => {};
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let calls = 0;
    const sweep = vi.fn(async (): Promise<ExpirySweepSummary> => {
      calls += 1;
      if (calls === 1) {
        await firstDone;
      }
      return EMPTY;
    });

    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger: silentLogger(),
      intervalMs: 1_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });

    // Three intervals pass while the first sweep is still in flight.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    // Only once the first pass has finished does the next tick start one.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("reports how many holds it ended and how many it refused, without logging any amount — catches a balance-like figure reaching a structured log line (docs/resilience.md §10), and a pass that refuses everything reading exactly like one with nothing to do", async () => {
    const logger = silentLogger();
    const sweep = vi.fn(
      async (): Promise<ExpirySweepSummary> => ({
        examined: 3,
        expired: 2,
        releasedByAsset: new Map([["1337|native|VGLSTABLE|SYNTHETIC_TESTNET", 600_000_000n]]),
        alreadyExpired: 1,
        refusals: [{ reservationId: "reservation-9", intentId: "intent-9", code: "INTENT_ATTEMPT_LIVE", detail: "still live" }],
        truncated: false,
      }),
    );

    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger,
      intervalMs: 60_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.info).toHaveBeenCalledWith(
      { examined: 3, expired: 2, alreadyExpired: 1, refused: 1 },
      "reservation expiry sweep pass",
    );
    // A hold left standing behind a live attempt is the sweep working, not
    // failing, so it is debug rather than warn.
    expect(logger.debug).toHaveBeenCalledWith(
      { reservationId: "reservation-9", intentId: "intent-9", code: "INTENT_ATTEMPT_LIVE" },
      "reservation left standing by the expiry sweep",
    );
    expect(logger.warn).not.toHaveBeenCalled();

    loop.stop();
  });

  it("warns when a pass runs out of page budget rather than out of holds — catches a backlog the sweep can never reach the end of going unreported, which is what head-of-line starvation looks like from outside", async () => {
    const logger = silentLogger();
    const sweep = vi.fn(
      async (): Promise<ExpirySweepSummary> => ({ ...EMPTY, examined: 5_000, refusals: [], truncated: true }),
    );

    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger,
      intervalMs: 60_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith(
      { examined: 5_000, expired: 0, refused: 0 },
      "reservation expiry sweep hit its page budget with holds still unexamined",
    );

    loop.stop();
  });

  it("keeps ticking when a pass throws synchronously instead of rejecting — catches the latch being left set by a throw that never becomes a rejection, which stops the sweep for the life of the process and says nothing", async () => {
    const logger = silentLogger();
    let calls = 0;
    // Not `async`: this throws on the call itself rather than returning a
    // rejected promise, which is the case a `.catch()` on the result never
    // sees.
    const sweep = vi.fn((): Promise<ExpirySweepSummary> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("sweep exploded on the way in");
      }
      return Promise.resolve(EMPTY);
    });

    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger,
      intervalMs: 1_000,
      now: () => "2026-01-02T03:11:00.000Z",
      sweep,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith({ error: "sweep exploded on the way in" }, "reservation expiry sweep failed");

    // The latch cleared, so the next tick actually runs.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("keeps ticking when the clock itself throws — catches the one throw that happens before the pass exists to catch anything, leaving the latch set with no pass to clear it", async () => {
    const logger = silentLogger();
    const sweep = vi.fn(async (): Promise<ExpirySweepSummary> => EMPTY);
    let reads = 0;
    const loop = startReservationExpirySweep({
      db: FAKE_DB,
      logger,
      intervalMs: 1_000,
      now: () => {
        reads += 1;
        if (reads === 1) {
          throw new Error("clock unavailable");
        }
        return "2026-01-02T03:11:00.000Z";
      },
      sweep,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ error: "clock unavailable" }, "reservation expiry sweep could not start");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    loop.stop();
  });
});
