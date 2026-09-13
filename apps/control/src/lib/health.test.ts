import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { StoredHeartbeat } from "@vigil/db";
import { describe, expect, it } from "vitest";

import { deriveRuntimeHealth, HEARTBEAT_STALE_AFTER_MS, QUOTE_STALE_AFTER_MS } from "./health";

const NOW = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");

function heartbeat(overrides: Partial<StoredHeartbeat> = {}): StoredHeartbeat {
  return {
    heartbeatId: "hb-1",
    process: "trading",
    instanceId: "instance-1",
    operatingMode: "PAPER",
    observedAt: "2024-06-01T12:00:00.000Z",
    recordedAt: "2024-06-01T12:00:00.000Z",
    lastQuoteAcquiredAt: null,
    detail: null,
    ...overrides,
  };
}

describe("deriveRuntimeHealth", () => {
  it("reads a fresh heartbeat with no quote as OK / NONE", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat()],
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.instances).toStrictEqual([
      expect.objectContaining({ heartbeat: "OK", quote: "NONE", heartbeatAgeMs: 0 }),
    ]);
    expect(result.paused).toBe(false);
  });

  it("reads a heartbeat older than the threshold as STALE", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat({ observedAt: "2024-06-01T11:59:00.000Z" })], // 60s old
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.instances[0]?.heartbeat).toBe("STALE");
  });

  it("reads a quote older than the threshold as STALE while the heartbeat itself is fresh", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat({ lastQuoteAcquiredAt: "2024-06-01T11:58:00.000Z" })], // 120s old
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.instances[0]?.heartbeat).toBe("OK");
    expect(result.instances[0]?.quote).toBe("STALE");
  });

  it("reports NEVER for a heartbeat whose own timestamp is corrupt, never as fresh", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat({ observedAt: "not-a-timestamp" })],
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.instances[0]?.heartbeat).toBe("NEVER");
    expect(result.instances[0]?.heartbeatAgeMs).toBeNull();
  });

  it("reports empty instances for no heartbeats, never a fabricated row", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [],
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.instances).toStrictEqual([]);
    expect(result.paused).toBe(false);
  });

  it("reports paused globally when the dashboard's own mode is PAUSED", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat()],
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAUSED",
    });
    expect(result.paused).toBe(true);
  });

  it("reports paused globally when any instance reports PAUSED, even if the dashboard mode is PAPER", () => {
    const result = deriveRuntimeHealth({
      heartbeats: [heartbeat({ operatingMode: "PAUSED" })],
      now: NOW,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: "PAPER",
    });
    expect(result.paused).toBe(true);
  });
});
