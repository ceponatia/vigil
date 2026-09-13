import { OPERATING_MODES } from "@vigil/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLatestHeartbeats, recordHeartbeat } from "./heartbeat-store";
import { openDecisionTestDb, storeHeartbeat } from "../test-support/decision-fixtures";

// The defects this file kills, all of them about a dashboard that reports a
// runtime as healthy when it is not:
//   * two replicas of one process collapsed into a single liveness row, or
//     one replica counted twice, so "the trading runtime is alive" is read
//     off a row that belongs to a different instance;
//   * an older heartbeat winning over a newer one, which leaves a stopped
//     process looking alive for as long as anyone watches;
//   * an operating mode nobody defined reaching a durable ops record, where
//     a dashboard would render whatever string it was handed.
//
// The real-infrastructure facts required are the unique natural key, the
// upsert that lands a redelivery on the existing row, and DISTINCT ON — none
// of which an in-memory double would be answering for.

const { db, close, reset } = openDecisionTestDb("vigil-heartbeat-store-test");

afterAll(close);
beforeEach(reset);

describe("recordHeartbeat", () => {
  it("refuses an operating mode that is not in the OPERATING_MODES registry and writes nothing — catches a free-text mode reaching a durable ops record, where a dashboard reports an authority state this application does not have", async () => {
    const invented = "LIVE_READONLY";
    expect(OPERATING_MODES).not.toContain(invented);

    const refused = await recordHeartbeat(db, storeHeartbeat({ operatingMode: invented }));

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.code).toBe("INVALID_OPERATING_MODE");
    }
    expect(await loadLatestHeartbeats(db)).toEqual([]);
  });

  it("refuses a heartbeat that does not name its process or its instance — catches a blank identity becoming a row that every runtime's heartbeats then merge into", async () => {
    const blankProcess = await recordHeartbeat(db, storeHeartbeat({ process: "  " }));
    const blankInstance = await recordHeartbeat(db, storeHeartbeat({ instanceId: "" }));

    for (const result of [blankProcess, blankInstance]) {
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.code).toBe("EMPTY_IDENTITY");
      }
    }
    expect(await loadLatestHeartbeats(db)).toEqual([]);
  });

  it("refuses a timestamp finer than the column can store and writes nothing — catches an observed instant silently truncated on the way in, which would report a runtime as last alive at a moment it never claimed", async () => {
    const refused = await recordHeartbeat(db, storeHeartbeat({ observedAt: "2026-01-02T03:04:05.0004Z" }));

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.code).toBe("INVALID_TIMESTAMP");
    }
    expect(await loadLatestHeartbeats(db)).toEqual([]);
  });

  it("lands a redelivered heartbeat on the row that already holds it — catches the same observation counted twice, which makes an idle runtime look like it is emitting", async () => {
    const first = await recordHeartbeat(db, storeHeartbeat());
    const redelivered = await recordHeartbeat(db, storeHeartbeat());

    expect(first.outcome).toBe("recorded");
    expect(redelivered.outcome).toBe("recorded");
    if (first.outcome === "recorded" && redelivered.outcome === "recorded") {
      expect(redelivered.heartbeatId).toBe(first.heartbeatId);
    }
    expect(await loadLatestHeartbeats(db)).toHaveLength(1);
  });
});

describe("loadLatestHeartbeats", () => {
  it("returns the newest heartbeat per process and instance, by the emitting runtime's own clock — catches a latest-row query that keys on the writer's clock or on insertion order, where a heartbeat that arrived late would hide the newer one behind it", async () => {
    const stale = storeHeartbeat({
      instanceId: "instance-a",
      observedAt: "2026-01-02T03:00:00.000Z",
      recordedAt: "2026-01-02T03:00:00.100Z",
      detail: "older observation, written last",
    });
    const fresh = storeHeartbeat({
      instanceId: "instance-a",
      observedAt: "2026-01-02T03:05:00.000Z",
      recordedAt: "2026-01-02T03:05:00.100Z",
      operatingMode: "PAUSED",
    });
    const otherInstance = storeHeartbeat({
      instanceId: "instance-b",
      observedAt: "2026-01-02T03:01:00.000Z",
      recordedAt: "2026-01-02T03:01:00.100Z",
      lastQuoteAcquiredAt: null,
    });
    const otherProcess = storeHeartbeat({
      process: "control",
      instanceId: "instance-a",
      observedAt: "2026-01-02T03:02:00.000Z",
      recordedAt: "2026-01-02T03:02:00.100Z",
    });

    for (const heartbeat of [fresh, otherInstance, otherProcess, stale]) {
      expect((await recordHeartbeat(db, heartbeat)).outcome).toBe("recorded");
    }

    const latest = await loadLatestHeartbeats(db);

    expect(latest.map((row) => `${row.process}/${row.instanceId}`)).toEqual([
      "control/instance-a",
      "trading/instance-a",
      "trading/instance-b",
    ]);
    const tradingA = latest.find((row) => row.process === "trading" && row.instanceId === "instance-a");
    expect(tradingA?.observedAt).toBe("2026-01-02T03:05:00.000Z");
    expect(tradingA?.operatingMode).toBe("PAUSED");
    expect(latest.find((row) => row.instanceId === "instance-b")?.lastQuoteAcquiredAt).toBeNull();
  });
});
