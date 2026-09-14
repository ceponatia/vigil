import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { RecordHeartbeatResult, StoreHeartbeat, VigilDatabase } from "@vigil/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildHeartbeat, startHeartbeatLoop } from "./heartbeat";
import type { HeartbeatLogger } from "./heartbeat";

// The defect this file kills: a liveness signal that is not one. A loop
// that writes once and stops, a tick that hands the store a corrupt
// timestamp, or a write failure that takes the runtime down all end the same
// way — the dashboard's health read (`apps/control/src/lib/health.ts`) can no
// longer tell a healthy runtime from a stopped one, and the heartbeat stops
// being the stale/paused signal it exists to be (docs/resilience.md §2:
// protective actions are never blocked by a provider or write failure).

const OBSERVED = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");
const RECORDED = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.010Z");

// Every startHeartbeatLoop test below injects `record`, so the loop never
// actually touches this value — it only needs to satisfy the parameter's
// type.
const FAKE_DB = {} as unknown as VigilDatabase;

type HeartbeatWriter = {
  readonly record: (db: VigilDatabase, heartbeat: StoreHeartbeat) => Promise<RecordHeartbeatResult>;
  /** Every heartbeat the loop actually handed the store, in write order. */
  readonly written: readonly StoreHeartbeat[];
};

function recordingWriter(): HeartbeatWriter {
  const written: StoreHeartbeat[] = [];
  return {
    written,
    record: (_db, heartbeat) => {
      written.push(heartbeat);
      return Promise.resolve({ outcome: "recorded", heartbeatId: `hb-${written.length.toString()}` });
    },
  };
}

type WarnCall = { readonly detail: Record<string, unknown>; readonly message: string };

type RecordingLogger = {
  readonly logger: HeartbeatLogger;
  /** Every warn the loop emitted, fully typed — no asymmetric matcher, no `any`. */
  readonly calls: readonly WarnCall[];
};

function recordingLogger(): RecordingLogger {
  const calls: WarnCall[] = [];
  return {
    calls,
    logger: {
      warn: (detail, message) => {
        calls.push({ detail, message });
      },
    },
  };
}

/** A clock returning each supplied read once, then repeating the last one. */
function clockOf(...reads: readonly string[]): () => string {
  let next = 0;
  return (): string => {
    const value = reads[Math.min(next, reads.length - 1)] ?? "";
    next += 1;
    return value;
  };
}

describe("buildHeartbeat", () => {
  it("names this runtime as the process and stamps observedAt/recordedAt from their own params", () => {
    const heartbeat = buildHeartbeat({
      observedAt: OBSERVED,
      recordedAt: OBSERVED,
      mode: "PAPER",
      instanceId: "instance-1",
      lastQuoteAcquiredAt: null,
    });
    expect(heartbeat).toStrictEqual({
      process: "trading",
      instanceId: "instance-1",
      operatingMode: "PAPER",
      observedAt: "2024-06-01T12:00:00.000Z",
      recordedAt: "2024-06-01T12:00:00.000Z",
      lastQuoteAcquiredAt: null,
      detail: null,
    });
  });

  it("keeps observedAt and recordedAt independent when the caller supplies two different reads", () => {
    const heartbeat = buildHeartbeat({
      observedAt: OBSERVED,
      recordedAt: RECORDED,
      mode: "PAPER",
      instanceId: "instance-1",
      lastQuoteAcquiredAt: null,
    });
    expect(heartbeat.observedAt).toBe("2024-06-01T12:00:00.000Z");
    expect(heartbeat.recordedAt).toBe("2024-06-01T12:00:00.010Z");
  });

  it("carries lastQuoteAcquiredAt through unchanged when supplied", () => {
    const heartbeat = buildHeartbeat({
      observedAt: OBSERVED,
      recordedAt: OBSERVED,
      mode: "PAPER",
      instanceId: "instance-1",
      lastQuoteAcquiredAt: "2024-06-01T11:59:00.000Z",
    });
    expect(heartbeat.lastQuoteAcquiredAt).toBe("2024-06-01T11:59:00.000Z");
  });

  it("defaults detail to null rather than undefined when omitted", () => {
    const heartbeat = buildHeartbeat({
      observedAt: OBSERVED,
      recordedAt: OBSERVED,
      mode: "PAUSED",
      instanceId: "instance-2",
      lastQuoteAcquiredAt: null,
    });
    expect(heartbeat.detail).toBeNull();
  });
});

describe("startHeartbeatLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a refused result via warn and does not throw", async () => {
    const warn = vi.fn();
    const record = vi.fn(
      async (): Promise<RecordHeartbeatResult> => ({
        outcome: "refused",
        code: "INVALID_OPERATING_MODE",
        detail: "not a real mode",
      }),
    );

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: { warn },
      intervalMs: 5_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: () => "2024-06-01T12:00:00.000Z",
      record,
    });

    // The constructor call already fired one synchronous tick; flush its
    // pending promise chain without advancing the fake clock.
    await vi.advanceTimersByTimeAsync(0);

    expect(record).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ code: "INVALID_OPERATING_MODE", detail: "not a real mode" }, "heartbeat refused");

    loop.stop();
  });

  it("logs a rejected write and does not throw", async () => {
    const warn = vi.fn();
    const record = vi.fn(async (): Promise<RecordHeartbeatResult> => {
      throw new Error("connection reset");
    });

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: { warn },
      intervalMs: 5_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: () => "2024-06-01T12:00:00.000Z",
      record,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith({ error: "connection reset" }, "heartbeat write failed");

    loop.stop();
  });

  it("keeps writing on every interval — a one-shot timer would leave the dashboard reading STALE forever", async () => {
    const logs = recordingLogger();
    const writer = recordingWriter();

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: logs.logger,
      intervalMs: 1_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: () => "2024-06-01T12:00:00.000Z",
      record: writer.record,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    loop.stop();

    // The immediate tick plus one per elapsed interval.
    expect(writer.written).toHaveLength(3);
    expect(writer.written[0]?.process).toBe("trading");
    // No quote source wired in: the loop reports null, never a stale reading
    // left over from somewhere else.
    expect(writer.written[0]?.lastQuoteAcquiredAt).toBeNull();
    expect(logs.calls).toStrictEqual([]);
  });

  it("takes two clock reads per tick, so recordedAt can be later than observedAt as the schema intends", async () => {
    const logs = recordingLogger();
    const writer = recordingWriter();

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: logs.logger,
      intervalMs: 5_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: clockOf("2024-06-01T12:00:00.000Z", "2024-06-01T12:00:00.010Z"),
      lastQuoteAcquiredAt: () => "2024-06-01T11:59:00.000Z",
      record: writer.record,
    });

    await vi.advanceTimersByTimeAsync(0);
    loop.stop();

    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]?.observedAt).toBe("2024-06-01T12:00:00.000Z");
    expect(writer.written[0]?.recordedAt).toBe("2024-06-01T12:00:00.010Z");
    expect(writer.written[0]?.lastQuoteAcquiredAt).toBe("2024-06-01T11:59:00.000Z");
    expect(logs.calls).toStrictEqual([]);
  });

  it("skips a tick whose clock produced no valid observedAt instead of writing a corrupt heartbeat", async () => {
    const logs = recordingLogger();
    const writer = recordingWriter();

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: logs.logger,
      intervalMs: 5_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: () => "not-a-timestamp",
      record: writer.record,
    });

    await vi.advanceTimersByTimeAsync(0);
    loop.stop();

    expect(writer.written).toStrictEqual([]);
    expect(logs.calls).toHaveLength(1);
    expect(logs.calls[0]?.detail).toStrictEqual({ rawObservedAt: "not-a-timestamp" });
    expect(logs.calls[0]?.message).toContain("observedAt");
  });

  it("skips a tick whose second clock read is not a valid recordedAt, rather than reusing observedAt for both", async () => {
    const logs = recordingLogger();
    const writer = recordingWriter();

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: logs.logger,
      intervalMs: 5_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: clockOf("2024-06-01T12:00:00.000Z", "not-a-timestamp"),
      record: writer.record,
    });

    await vi.advanceTimersByTimeAsync(0);
    loop.stop();

    expect(writer.written).toStrictEqual([]);
    expect(logs.calls).toHaveLength(1);
    expect(logs.calls[0]?.detail).toStrictEqual({ rawRecordedAt: "not-a-timestamp" });
    expect(logs.calls[0]?.message).toContain("recordedAt");
  });

  it("writes no further heartbeat once stop() has been called", async () => {
    const warn = vi.fn();
    const record = vi.fn(async (): Promise<RecordHeartbeatResult> => ({ outcome: "recorded", heartbeatId: "hb-1" }));

    const loop = startHeartbeatLoop({
      db: FAKE_DB,
      logger: { warn },
      intervalMs: 1_000,
      mode: "PAPER",
      instanceId: "instance-1",
      now: () => "2024-06-01T12:00:00.000Z",
      record,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledTimes(1);

    loop.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
