import { operatingModeSchema } from "@vigil/contracts";
import { asc, desc } from "drizzle-orm";

import type { VigilDatabase } from "../client";
import { heartbeats } from "../schema/ops";
import { parseIsoInstant } from "./instants";

/**
 * Writing and reading runtime liveness.
 *
 * A heartbeat says nothing about money, so this module is deliberately the
 * plainest store in the package: no transaction, no provenance, no
 * idempotency key. What it does owe its reader is honesty about what it does
 * not know — a dashboard renders "the trading runtime is alive" from these
 * rows, and a heartbeat store that quietly invented a timestamp, or that
 * accepted an operating mode nobody defined, would render a green light for
 * a process that is not running.
 *
 * So: every value is parsed against `@vigil/contracts` before it is written
 * (`docs/resilience.md` §5), a refusal is a diagnostic rather than an
 * exception (§4), and a redelivery of the same observation lands on the row
 * that is already there instead of doubling a runtime's apparent liveness.
 */

export const HEARTBEAT_STORE_DIAGNOSTIC_CODES = [
  /** A timestamp is not an ISO-8601 UTC instant on a real calendar day. */
  "INVALID_TIMESTAMP",
  /** The mode is not a member of `@vigil/contracts`' `OPERATING_MODES`. */
  "INVALID_OPERATING_MODE",
  /** The heartbeat does not say which process, or which instance of it, emitted it. */
  "EMPTY_IDENTITY",
] as const;

export type HeartbeatStoreDiagnosticCode = (typeof HEARTBEAT_STORE_DIAGNOSTIC_CODES)[number];

export type StoreHeartbeat = {
  /** Which deployable emitted this, for example `trading`. */
  readonly process: string;
  readonly instanceId: string;
  /** An `OPERATING_MODES` member. */
  readonly operatingMode: string;
  /** ISO-8601 UTC; the emitting runtime's own clock. */
  readonly observedAt: string;
  /** ISO-8601 UTC. */
  readonly recordedAt: string;
  /** ISO-8601 UTC; the newest market quote the runtime has seen, or null. */
  readonly lastQuoteAcquiredAt: string | null;
  readonly detail: string | null;
};

export type StoredHeartbeat = StoreHeartbeat & { readonly heartbeatId: string };

export type RecordHeartbeatResult =
  | { readonly outcome: "recorded"; readonly heartbeatId: string }
  | { readonly outcome: "refused"; readonly code: HeartbeatStoreDiagnosticCode; readonly detail: string };

/**
 * Record one heartbeat.
 *
 * A redelivery — the same process, instance, and observed instant — is the
 * same observation, so it comes back as `recorded` carrying the id of the
 * row that already holds it, and no second row is written. There is no
 * `duplicate` outcome to report: nothing downstream spends or authorizes
 * anything on the strength of a heartbeat, so "this liveness is already
 * recorded" and "this liveness is now recorded" are the same answer to the
 * caller, and the unique natural key is what keeps it to one row.
 */
export async function recordHeartbeat(db: VigilDatabase, heartbeat: StoreHeartbeat): Promise<RecordHeartbeatResult> {
  if (heartbeat.process.trim() === "" || heartbeat.instanceId.trim() === "") {
    return {
      outcome: "refused",
      code: "EMPTY_IDENTITY",
      detail: "a heartbeat names the process and the instance that emitted it; one of them is blank",
    };
  }

  if (!operatingModeSchema.safeParse(heartbeat.operatingMode).success) {
    return {
      outcome: "refused",
      code: "INVALID_OPERATING_MODE",
      detail: `${heartbeat.process}/${heartbeat.instanceId} reports operating mode ${heartbeat.operatingMode}, which is not in the OPERATING_MODES registry (docs/policy.md)`,
    };
  }

  const observedAt = parseIsoInstant(heartbeat.observedAt);
  const recordedAt = parseIsoInstant(heartbeat.recordedAt);
  const lastQuoteAcquiredAt =
    heartbeat.lastQuoteAcquiredAt === null ? null : parseIsoInstant(heartbeat.lastQuoteAcquiredAt);

  if (
    observedAt === null ||
    recordedAt === null ||
    (heartbeat.lastQuoteAcquiredAt !== null && lastQuoteAcquiredAt === null)
  ) {
    return {
      outcome: "refused",
      code: "INVALID_TIMESTAMP",
      detail: `${heartbeat.process}/${heartbeat.instanceId} carries a timestamp that is not an ISO-8601 UTC instant on a real calendar day`,
    };
  }

  // `DO UPDATE` setting the conflict key back to the value it already holds,
  // rather than `DO NOTHING`: the two write exactly the same row, but
  // `DO NOTHING` returns nothing, which would leave this function with no id
  // to report and a second query whose empty case cannot honestly be
  // handled. This way the row that exists is always the row that comes back.
  const written = await db
    .insert(heartbeats)
    .values({
      process: heartbeat.process,
      instanceId: heartbeat.instanceId,
      operatingMode: heartbeat.operatingMode,
      observedAt,
      recordedAt,
      lastQuoteAcquiredAt,
      detail: heartbeat.detail,
    })
    .onConflictDoUpdate({
      target: [heartbeats.process, heartbeats.instanceId, heartbeats.observedAt],
      set: { observedAt },
    })
    .returning({ heartbeatId: heartbeats.heartbeatId });

  const row = written[0];
  if (row === undefined) {
    // An upsert whose conflict action is DO UPDATE always returns its row,
    // so reaching here means the driver broke its own contract. Thrown, not
    // refused: every refusal code in this module names something a caller
    // supplied, and dressing a broken driver up as one of them would put a
    // reason code on the record that is not the reason (`docs/resilience.md`
    // §4 reserves exceptions for exactly this).
    throw new Error("recordHeartbeat: the upsert returned no row, which an ON CONFLICT DO UPDATE cannot do");
  }

  return { outcome: "recorded", heartbeatId: row.heartbeatId };
}

/**
 * The newest heartbeat per (process, instance), by the emitting runtime's
 * own clock.
 *
 * `DISTINCT ON` rather than a read-everything-and-fold: heartbeats
 * accumulate for as long as the runtime runs and nothing prunes them yet, so
 * folding in memory would make this call slower every hour. Ordered by
 * process then instance so the dashboard's row order does not change between
 * two calls that returned the same runtimes.
 */
export async function loadLatestHeartbeats(db: VigilDatabase): Promise<readonly StoredHeartbeat[]> {
  const rows = await db
    .selectDistinctOn([heartbeats.process, heartbeats.instanceId])
    .from(heartbeats)
    .orderBy(
      asc(heartbeats.process),
      asc(heartbeats.instanceId),
      desc(heartbeats.observedAt),
      desc(heartbeats.recordedAt),
    );

  return rows.map((row) => ({
    heartbeatId: row.heartbeatId,
    process: row.process,
    instanceId: row.instanceId,
    operatingMode: row.operatingMode,
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    lastQuoteAcquiredAt: row.lastQuoteAcquiredAt === null ? null : row.lastQuoteAcquiredAt.toISOString(),
    detail: row.detail,
  }));
}
