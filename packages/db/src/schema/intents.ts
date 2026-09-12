import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { BASE_UNIT_PRECISION, journalEntries } from "./journal";

/**
 * The `intents` record family: capital authority
 * (`docs/architecture.md` "Record families"). Reservations land here in this
 * slice; approved intents and the outbox arrive with the execution slice
 * that gives them their lifecycle.
 *
 * A reservation is the durable record that capital is committed to one
 * intent, written **before** anything acts on it (`docs/resilience.md` §9).
 * Three unique constraints carry invariants the application must not be
 * trusted to hold on its own:
 *
 * - `idempotency_key` — the same reservation request delivered twice holds
 *   funds once.
 * - `(intent_id, attempt)` — a retry is a versioned attempt on the same
 *   intent, never a second authorization to spend.
 * - `journal_entry_id` — exactly one hold posting per reservation, so a
 *   reservation cannot be backed by two different balance movements.
 */

export const reservationStateEnum = pgEnum("reservation_state", [
  "active",
  "released",
  "consumed",
  "expired",
]);

export const reservations = pgTable(
  "reservations",
  {
    reservationId: text("reservation_id").primaryKey(),
    /** The approved economic intent this reservation serves. */
    intentId: text("intent_id").notNull(),
    /** Versioned attempt on that intent; starts at 1. */
    attempt: integer("attempt").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    assetId: text("asset_id").notNull(),
    assetScale: smallint("asset_scale").notNull(),
    amountBase: numeric("amount_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" }).notNull(),
    state: reservationStateEnum("state").notNull().default("active"),
    /** The `reservation-hold` entry that moved the funds. */
    journalEntryId: text("journal_entry_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** After this instant the hold authorizes nothing. */
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("reservations_idempotency_key_key").on(table.idempotencyKey),
    uniqueIndex("reservations_intent_id_attempt_key").on(table.intentId, table.attempt),
    uniqueIndex("reservations_journal_entry_id_key").on(table.journalEntryId),
    index("reservations_correlation_id_idx").on(table.correlationId),
    index("reservations_state_expires_at_idx").on(table.state, table.expiresAt),
    foreignKey({
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.entryId],
      name: "reservations_journal_entry_id_fk",
    }),
    check("reservations_amount_positive", sql`amount_base > 0`),
    check("reservations_attempt_positive", sql`attempt >= 1`),
    check("reservations_scale_range", sql`asset_scale between 0 and 36`),
    check("reservations_window", sql`expires_at > occurred_at`),
  ],
);

export type ReservationStateValue = (typeof reservationStateEnum.enumValues)[number];
