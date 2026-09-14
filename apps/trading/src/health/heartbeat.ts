import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp } from "@vigil/contracts";
import { recordHeartbeat } from "@vigil/db";
import type { RecordHeartbeatResult, StoreHeartbeat, VigilDatabase } from "@vigil/db";

/**
 * heartbeat.ts — this runtime's liveness signal (docs/architecture.md
 * "Record families", `ops`; `apps/trading/README.md` "Planned module
 * directories", `health/`). Every `@vigil/db` heartbeat name this runtime
 * uses is imported here and nowhere else, so a small signature drift
 * against the pinned interface contract (BOOT-07 brief) is a one-file fix.
 *
 * `recordHeartbeat` is a pinned export the concurrent db slice has not
 * landed yet on this branch — this file (and anything that imports it)
 * fails to resolve until the parent merges that slice in, which is
 * expected (BOOT-07 brief).
 */

export type BuildHeartbeatParams = {
  /** When the emitting runtime observed its own liveness. */
  readonly observedAt: IsoUtcTimestamp;
  /** When this heartbeat is being written — a separate clock read, per the schema's intent that the two may differ. */
  readonly recordedAt: IsoUtcTimestamp;
  readonly mode: string;
  readonly instanceId: string;
  readonly lastQuoteAcquiredAt: string | null;
  readonly detail?: string | null;
};

/** Pure: no clock read, no IO. `startHeartbeatLoop` below is what calls this on a schedule. */
export function buildHeartbeat(params: BuildHeartbeatParams): StoreHeartbeat {
  return {
    process: "trading",
    instanceId: params.instanceId,
    operatingMode: params.mode,
    observedAt: params.observedAt,
    recordedAt: params.recordedAt,
    lastQuoteAcquiredAt: params.lastQuoteAcquiredAt,
    detail: params.detail ?? null,
  };
}

/**
 * The narrow logging surface this module needs — satisfied directly by a
 * pino `Logger` without importing its type, so a test can hand this a
 * plain recording fake instead of constructing a real logger.
 */
export type HeartbeatLogger = {
  readonly warn: (detail: Record<string, unknown>, message: string) => void;
};

export type StartHeartbeatLoopParams = {
  readonly db: VigilDatabase;
  readonly logger: HeartbeatLogger;
  readonly intervalMs: number;
  readonly mode: string;
  readonly instanceId: string;
  readonly now: () => string;
  readonly lastQuoteAcquiredAt?: () => string | null;
  /**
   * Defaults to `@vigil/db`'s `recordHeartbeat`. Overridable so a test can
   * hand this a fake and assert the loop's fail-closed behavior (a refused
   * result, or a rejected promise) without a real database — the loop
   * itself never depends on the override existing.
   */
  readonly record?: (db: VigilDatabase, heartbeat: StoreHeartbeat) => Promise<RecordHeartbeatResult>;
};

export type HeartbeatLoop = {
  readonly stop: () => void;
};

/**
 * Writes a heartbeat immediately, then every `intervalMs`. `recordHeartbeat`
 * returning a `refused` diagnostic — or its promise rejecting outright — is
 * logged and the loop keeps running: a stalled heartbeat writer is itself
 * the stale/paused signal the dashboard shows (`apps/control/src/lib/health.ts`),
 * not a reason to crash a process that could still protect open positions
 * (docs/resilience.md §2 "Protective actions are never blocked by research
 * or provider failure").
 */
export function startHeartbeatLoop(params: StartHeartbeatLoopParams): HeartbeatLoop {
  const record = params.record ?? recordHeartbeat;

  const tick = (): void => {
    const rawObservedAt = params.now();
    const parsedObservedAt = isoUtcTimestampSchema.safeParse(rawObservedAt);
    if (!parsedObservedAt.success) {
      params.logger.warn(
        { rawObservedAt },
        "heartbeat tick skipped: clock did not produce a valid ISO-8601 timestamp for observedAt",
      );
      return;
    }

    // A second, later clock read for recordedAt — taken immediately before
    // the write, not reused from observedAt above, so the two timestamps
    // can differ the way the schema intends (`packages/db`'s heartbeat
    // store keeps both).
    const rawRecordedAt = params.now();
    const parsedRecordedAt = isoUtcTimestampSchema.safeParse(rawRecordedAt);
    if (!parsedRecordedAt.success) {
      params.logger.warn(
        { rawRecordedAt },
        "heartbeat tick skipped: clock did not produce a valid ISO-8601 timestamp for recordedAt",
      );
      return;
    }

    const heartbeat = buildHeartbeat({
      observedAt: parsedObservedAt.data,
      recordedAt: parsedRecordedAt.data,
      mode: params.mode,
      instanceId: params.instanceId,
      lastQuoteAcquiredAt: params.lastQuoteAcquiredAt?.() ?? null,
    });

    record(params.db, heartbeat)
      .then((result) => {
        if (result.outcome === "refused") {
          params.logger.warn({ code: result.code, detail: result.detail }, "heartbeat refused");
        }
      })
      .catch((error: unknown) => {
        params.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "heartbeat write failed");
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
