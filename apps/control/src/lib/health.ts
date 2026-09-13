import { ageMs, isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp, OperatingMode } from "@vigil/contracts";
import type { StoredHeartbeat } from "@vigil/db";

/**
 * health.ts — turns the latest heartbeat per runtime instance into the
 * dashboard's stale/paused read (docs/architecture.md "Record families",
 * `ops`; docs/resilience.md §1 "Fail closed on financial authority" — a
 * stale heartbeat or quote must be visibly represented, never silently
 * hidden behind a dashboard that just stops updating a number).
 *
 * Only `@vigil/db`'s `StoredHeartbeat` TYPE is imported here — no runtime
 * dependency on the store functions that produce it.
 */

/**
 * A heartbeat older than three loop intervals (`apps/trading/src/main.ts`
 * runs the loop roughly every 5s) is stale rather than merely a little
 * behind — long enough to absorb one missed tick without flapping, short
 * enough that a genuinely stopped runtime shows STALE within seconds, not
 * minutes. No environment variable controls this yet (BOOT-07 brief).
 */
export const HEARTBEAT_STALE_AFTER_MS = 15_000;

/**
 * A quote older than a minute is stale for display purposes. This is a
 * dashboard-only threshold, independent of whatever freshness window
 * `@vigil/market`'s own freshness check (`packages/market/src/freshness.ts`)
 * applies before a candidate is allowed to execute — apps/control may not
 * import `@vigil/market` at all (docs/architecture.md "Layer graph and
 * import rules"), so it cannot share that constant and does not try to.
 */
export const QUOTE_STALE_AFTER_MS = 60_000;

export type HeartbeatStatus = "OK" | "STALE" | "NEVER";
export type QuoteStatus = "OK" | "STALE" | "NONE";

export type RuntimeInstanceHealth = {
  readonly process: string;
  readonly instanceId: string;
  readonly mode: string;
  readonly heartbeat: HeartbeatStatus;
  readonly heartbeatAgeMs: number | null;
  readonly quote: QuoteStatus;
  readonly quoteAgeMs: number | null;
  readonly detail: string | null;
};

export type RuntimeHealth = {
  readonly instances: readonly RuntimeInstanceHealth[];
  readonly paused: boolean;
};

export type DeriveRuntimeHealthParams = {
  readonly heartbeats: readonly StoredHeartbeat[];
  readonly now: IsoUtcTimestamp;
  readonly heartbeatStaleAfterMs: number;
  readonly quoteStaleAfterMs: number;
  readonly dashboardMode: OperatingMode;
};

function heartbeatStatus(observedAt: string, now: IsoUtcTimestamp, staleAfterMs: number): { status: HeartbeatStatus; ageMs: number | null } {
  const parsed = isoUtcTimestampSchema.safeParse(observedAt);
  if (!parsed.success) {
    // A heartbeat row exists but its own timestamp is corrupt: treated the
    // same as never having received one, never as fresh.
    return { status: "NEVER", ageMs: null };
  }
  const age = ageMs(parsed.data, now);
  return { status: age > staleAfterMs ? "STALE" : "OK", ageMs: age };
}

function quoteStatus(
  lastQuoteAcquiredAt: string | null,
  now: IsoUtcTimestamp,
  staleAfterMs: number,
): { status: QuoteStatus; ageMs: number | null } {
  if (lastQuoteAcquiredAt === null) {
    return { status: "NONE", ageMs: null };
  }
  const parsed = isoUtcTimestampSchema.safeParse(lastQuoteAcquiredAt);
  if (!parsed.success) {
    return { status: "NONE", ageMs: null };
  }
  const age = ageMs(parsed.data, now);
  return { status: age > staleAfterMs ? "STALE" : "OK", ageMs: age };
}

/**
 * `heartbeats` is expected to already be one row per `(process, instanceId)`
 * — `@vigil/db`'s `loadLatestHeartbeats` contract promises "newest per
 * (process, instanceId)" — so this function does no deduplication of its
 * own; it only reads ages and derives statuses.
 */
export function deriveRuntimeHealth(params: DeriveRuntimeHealthParams): RuntimeHealth {
  const instances = params.heartbeats.map((heartbeat): RuntimeInstanceHealth => {
    const hb = heartbeatStatus(heartbeat.observedAt, params.now, params.heartbeatStaleAfterMs);
    const quote = quoteStatus(heartbeat.lastQuoteAcquiredAt, params.now, params.quoteStaleAfterMs);
    return {
      process: heartbeat.process,
      instanceId: heartbeat.instanceId,
      mode: heartbeat.operatingMode,
      heartbeat: hb.status,
      heartbeatAgeMs: hb.ageMs,
      quote: quote.status,
      quoteAgeMs: quote.ageMs,
      detail: heartbeat.detail,
    };
  });

  const paused = params.dashboardMode === "PAUSED" || instances.some((instance) => instance.mode === "PAUSED");

  return { instances, paused };
}
