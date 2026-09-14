import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { RecordHeartbeatResult, VigilDatabase } from "@vigil/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildHeartbeat, startHeartbeatLoop } from "./heartbeat";

const OBSERVED = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");
const RECORDED = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.010Z");

// Every startHeartbeatLoop test below injects `record`, so the loop never
// actually touches this value — it only needs to satisfy the parameter's
// type.
const FAKE_DB = {} as unknown as VigilDatabase;

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
