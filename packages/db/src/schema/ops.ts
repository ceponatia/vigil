import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * The `ops` record family: operational health and authority
 * (`docs/architecture.md` "Record families"). Heartbeats land here in this
 * slice; incidents, permission audits, and operating budgets arrive with the
 * slices that own them.
 *
 * A heartbeat is a runtime saying what it is and when it last knew it was
 * alive. It is not an economic record: it carries no idempotency key, no
 * correlation id, and no provenance, because nothing downstream may spend,
 * authorize, or attribute anything on the strength of one. What it must
 * carry instead is the two timestamps a reader needs to tell "alive" from
 * "stopped an hour ago" apart:
 *
 * - `observed_at` is the emitting runtime's own clock — when it believed it
 *   was healthy;
 * - `recorded_at` is when this application wrote that down.
 *
 * Keeping both is what lets a dashboard distinguish a runtime that stopped
 * emitting from a writer that stopped persisting, which one generic
 * `created_at` cannot. `last_quote_acquired_at` is the newest market quote
 * that runtime had seen, so a stale-quote state is visible without joining
 * the market snapshot the runtime was reading.
 *
 * Heartbeats are append-only in practice — nothing updates one — but they
 * carry no append-only trigger: unlike a candidate or a journal entry, a
 * heartbeat is an observation with no economic consequence, and a retention
 * policy that eventually deletes old rows is a later slice's to write rather
 * than a trigger's to forbid.
 */

export const heartbeats = pgTable(
  "heartbeats",
  {
    /**
     * A surrogate key, not a key derived from the identity below.
     * `process:instanceId:observedAt` would look tidier and read back
     * deterministically, but it is ambiguous — a process named `trading:eu`
     * on instance `1` and a process named `trading` on instance `eu:1`
     * derive the same string — and two runtimes that collided there would be
     * silently reported as one. The natural key is a unique constraint
     * instead, which is the guarantee that actually matters: one row per
     * (process, instance, observed instant).
     */
    heartbeatId: uuid("heartbeat_id").primaryKey().defaultRandom(),
    /** Which deployable emitted this: `trading`, and later `control`. */
    process: text("process").notNull(),
    /** Which instance of it, so two replicas are never averaged into one. */
    instanceId: text("instance_id").notNull(),
    /**
     * The mode that runtime was operating in. Text validated against
     * `@vigil/contracts`' `OPERATING_MODES` at the store boundary rather
     * than a Postgres enum: that registry is owned by `packages/contracts`
     * and restating it here would give the application two vocabularies that
     * drift apart without anything noticing. Recording a mode grants no
     * authority — enabling SHADOW or LIVE is an owner action behind the
     * capability gate in `docs/policy.md`, and no row here opens it.
     */
    operatingMode: text("operating_mode").notNull(),
    /** The emitting runtime's own clock. */
    observedAt: timestamp("observed_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote it down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** The newest market quote that runtime had seen; null when it had seen none. */
    lastQuoteAcquiredAt: timestamp("last_quote_acquired_at", { withTimezone: true, precision: 3, mode: "date" }),
    /** Free-text operator context; null when there is nothing to say. */
    detail: text("detail"),
  },
  (table) => [
    // The natural key. A heartbeat re-delivered for the same instant is the
    // same observation, so this is what makes a redelivery land on the
    // existing row instead of doubling a runtime's apparent liveness.
    uniqueIndex("heartbeats_process_instance_id_observed_at_key").on(
      table.process,
      table.instanceId,
      table.observedAt,
    ),
    check(
      "heartbeats_identity_present",
      sql`length(btrim(process)) > 0 and length(btrim(instance_id)) > 0`,
    ),
  ],
);
