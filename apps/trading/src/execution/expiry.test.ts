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

const EMPTY: ExpirySweepSummary = { examined: 0, expired: 0, releasedBase: 0n, alreadyExpired: 0, refusals: [] };

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
    expect(summary.releasedBase).toBe(0n);
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

  it("reports how many holds it ended without logging the amount — catches a balance-like figure reaching a structured log line (docs/resilience.md §10)", async () => {
    const logger = silentLogger();
    const sweep = vi.fn(
      async (): Promise<ExpirySweepSummary> => ({
        examined: 3,
        expired: 2,
        releasedBase: 600_000_000n,
        alreadyExpired: 1,
        refusals: [{ reservationId: "reservation-9", intentId: "intent-9", code: "INTENT_ATTEMPT_LIVE", detail: "still live" }],
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

    expect(logger.info).toHaveBeenCalledWith({ expired: 2, examined: 3 }, "expired reservations released");
    // A hold left standing behind a live attempt is the sweep working, not
    // failing, so it is debug rather than warn.
    expect(logger.debug).toHaveBeenCalledWith(
      { reservationId: "reservation-9", intentId: "intent-9", code: "INTENT_ATTEMPT_LIVE" },
      "reservation left standing by the expiry sweep",
    );
    expect(logger.warn).not.toHaveBeenCalled();

    loop.stop();
  });
});
