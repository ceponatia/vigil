import { isoUtcTimestampSchema } from "@vigil/contracts";
import { describe, expect, it } from "vitest";

import { buildHeartbeat } from "./heartbeat";

const NOW = isoUtcTimestampSchema.parse("2024-06-01T12:00:00.000Z");

describe("buildHeartbeat", () => {
  it("names this runtime as the process and stamps observedAt/recordedAt with now", () => {
    const heartbeat = buildHeartbeat({
      now: NOW,
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

  it("carries lastQuoteAcquiredAt through unchanged when supplied", () => {
    const heartbeat = buildHeartbeat({
      now: NOW,
      mode: "PAPER",
      instanceId: "instance-1",
      lastQuoteAcquiredAt: "2024-06-01T11:59:00.000Z",
    });
    expect(heartbeat.lastQuoteAcquiredAt).toBe("2024-06-01T11:59:00.000Z");
  });

  it("defaults detail to null rather than undefined when omitted", () => {
    const heartbeat = buildHeartbeat({ now: NOW, mode: "PAUSED", instanceId: "instance-2", lastQuoteAcquiredAt: null });
    expect(heartbeat.detail).toBeNull();
  });
});
