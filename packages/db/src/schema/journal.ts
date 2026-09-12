import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The `journal` record family: journal entries, their postings, and the
 * balance projection derived from them (`docs/architecture.md` "Record
 * families").
 *
 * Three schema decisions carry the financial invariants, and each is a
 * database constraint rather than an application convention:
 *
 * 1. **No floating point anywhere.** Every money or quantity column is
 *    `numeric(78, 0)` — an exact integer count of base units — beside the
 *    `asset_scale` column that says how many decimal places those units
 *    represent. 78 digits covers a 256-bit integer, so an 18-decimal token
 *    balance cannot overflow it the way an 8-byte `bigint` would at roughly
 *    9.2 units of an 18-decimal asset. `real` and `double precision` never
 *    appear.
 * 2. **A holdings account can never go negative.** `ledger_balances` keeps
 *    debit and credit totals in separate, monotonically increasing columns,
 *    so "spent more than we hold" is the single check constraint
 *    `debit_base >= credit_base` on the holdings family. That constraint,
 *    not application ordering, is what makes two concurrent reservations
 *    unable to both commit an infeasible aggregate.
 * 3. **Entries are append-only.** The reversal link is unique, so an entry
 *    can be corrected exactly once, and a trigger (see the
 *    `journal_append_only_guard` migration) rejects every `UPDATE` and
 *    `DELETE` against a posted entry or posting.
 *
 * Timestamps are `timestamptz(3)`: millisecond precision, matching what an
 * ISO-8601 timestamp carries, so a value cannot be stored at a precision the
 * application is unable to read back and replay exactly.
 */

/** Digits in a base-unit column: enough for a 256-bit integer. */
export const BASE_UNIT_PRECISION = 78;

/** Largest `asset_scale` any column accepts; mirrors `@vigil/ledger`. */
export const MAX_ASSET_SCALE = 36;

/**
 * The six TASK-07 holdings states (`docs/product.md`). Only `available` and
 * `reserved` move in this slice; the other four exist now so a later slice
 * cannot quietly fold a locked balance into spendable cash for want of a
 * value to put in this column.
 */
export const holdingsStateEnum = pgEnum("holdings_state", [
  "available",
  "reserved",
  "staked",
  "unbonding",
  "pending-transfer",
  "exit-queued",
]);

export const accountFamilyEnum = pgEnum("account_family", [
  "holdings",
  "contributed-capital",
  "realized-pnl",
  "fees",
  "exchange",
]);

export const journalEntryKindEnum = pgEnum("journal_entry_kind", [
  "contribution",
  "distribution",
  "trade",
  "fee",
  "realized-pnl",
  "reservation-hold",
  "reservation-release",
  "reversal",
]);

export const postingDirectionEnum = pgEnum("posting_direction", ["debit", "credit"]);

export const journalEntries = pgTable(
  "journal_entries",
  {
    entryId: text("entry_id").primaryKey(),
    /**
     * Replay order. A rebuild reads entries by this column, not by a
     * timestamp: two entries recorded in the same millisecond would have no
     * defined order otherwise, and a correction that replayed before the
     * entry it corrects is a rebuild that fails or, worse, does not.
     *
     * It orders a **full** reload and nothing else. Sequence values are
     * drawn before commit, so two concurrent writers can commit out of
     * order — 8 becoming visible before 7 — and a tailing consumer that
     * remembered `entry_sequence > lastSeen` would skip the laggard
     * permanently. Reading the whole journal, which is what a restart does,
     * is unaffected: every committed row is present and its order is total.
     * An incremental consumer needs a different mechanism than this column.
     */
    entrySequence: bigserial("entry_sequence", { mode: "bigint" }).notNull(),
    kind: journalEntryKindEnum("kind").notNull(),
    /** When the economic event happened. */
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** When this application wrote it down. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
    /** Traces the entry to its intent, attempts, and outcome. */
    correlationId: text("correlation_id").notNull(),
    /** The same economic event delivered twice posts once. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The approved economic intent this entry settles, when there is one. */
    intentId: text("intent_id"),
    /** Non-null exactly when `kind` is `reversal`. */
    reversesEntryId: text("reverses_entry_id"),
  },
  (table) => [
    uniqueIndex("journal_entries_entry_sequence_key").on(table.entrySequence),
    uniqueIndex("journal_entries_idempotency_key_key").on(table.idempotencyKey),
    // At most one reversal per entry: a retried correction cannot subtract
    // the same amount twice. NULLs are distinct, so ordinary entries are
    // unaffected.
    uniqueIndex("journal_entries_reverses_entry_id_key").on(table.reversesEntryId),
    index("journal_entries_correlation_id_idx").on(table.correlationId),
    foreignKey({
      columns: [table.reversesEntryId],
      foreignColumns: [table.entryId],
      name: "journal_entries_reverses_entry_id_fk",
    }),
    check(
      "journal_entries_reversal_link",
      sql`(kind = 'reversal') = (reverses_entry_id is not null)`,
    ),
    check("journal_entries_no_self_reversal", sql`reverses_entry_id is null or reverses_entry_id <> entry_id`),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    entryId: text("entry_id").notNull(),
    lineIndex: integer("line_index").notNull(),
    /** `family|state|assetId`; the key `ledger_balances` is keyed by. */
    accountKey: text("account_key").notNull(),
    accountFamily: accountFamilyEnum("account_family").notNull(),
    holdingsState: holdingsStateEnum("holdings_state"),
    /** Canonical asset id. A later slice adds the `assets` table and this FK. */
    assetId: text("asset_id").notNull(),
    assetScale: smallint("asset_scale").notNull(),
    direction: postingDirectionEnum("direction").notNull(),
    /** Always positive; `direction` carries the sign. */
    amountBase: numeric("amount_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.lineIndex] }),
    foreignKey({
      columns: [table.entryId],
      foreignColumns: [journalEntries.entryId],
      name: "journal_lines_entry_id_fk",
    }),
    index("journal_lines_account_key_idx").on(table.accountKey),
    check("journal_lines_amount_positive", sql`amount_base > 0`),
    check("journal_lines_scale_range", sql`asset_scale between 0 and 36`),
    check("journal_lines_holdings_state", sql`(account_family = 'holdings') = (holdings_state is not null)`),
    check("journal_lines_line_index_non_negative", sql`line_index >= 0`),
  ],
);

export const ledgerBalances = pgTable(
  "ledger_balances",
  {
    accountKey: text("account_key").primaryKey(),
    accountFamily: accountFamilyEnum("account_family").notNull(),
    holdingsState: holdingsStateEnum("holdings_state"),
    assetId: text("asset_id").notNull(),
    assetScale: smallint("asset_scale").notNull(),
    /** Sum of every debit posted to this account. Only ever increases. */
    debitBase: numeric("debit_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Sum of every credit posted to this account. Only ever increases. */
    creditBase: numeric("credit_base", { precision: BASE_UNIT_PRECISION, scale: 0, mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** `recorded_at` of the most recent entry folded into this row. */
    lastRecordedAt: timestamp("last_recorded_at", { withTimezone: true, precision: 3, mode: "date" }).notNull(),
  },
  (table) => [
    check("ledger_balances_totals_non_negative", sql`debit_base >= 0 and credit_base >= 0`),
    // The durable half of the no-overspend guarantee: whatever the
    // application believes, the database will not let a holdings account
    // credit out more than it has debited in.
    check("ledger_balances_holdings_never_negative", sql`account_family <> 'holdings' or debit_base >= credit_base`),
    check("ledger_balances_holdings_state", sql`(account_family = 'holdings') = (holdings_state is not null)`),
    check("ledger_balances_scale_range", sql`asset_scale between 0 and 36`),
    index("ledger_balances_asset_id_idx").on(table.assetId),
  ],
);

export type HoldingsStateValue = (typeof holdingsStateEnum.enumValues)[number];
export type AccountFamilyValue = (typeof accountFamilyEnum.enumValues)[number];
export type JournalEntryKindValue = (typeof journalEntryKindEnum.enumValues)[number];
export type PostingDirectionValue = (typeof postingDirectionEnum.enumValues)[number];
