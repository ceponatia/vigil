CREATE TYPE "public"."reservation_state" AS ENUM('active', 'released', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."account_family" AS ENUM('holdings', 'contributed-capital', 'realized-pnl', 'fees', 'exchange');--> statement-breakpoint
CREATE TYPE "public"."holdings_state" AS ENUM('available', 'reserved', 'staked', 'unbonding', 'pending-transfer', 'exit-queued');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_kind" AS ENUM('contribution', 'distribution', 'trade', 'fee', 'realized-pnl', 'reservation-hold', 'reservation-release', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."posting_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TABLE "reservations" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_scale" smallint NOT NULL,
	"amount_base" numeric(78, 0) NOT NULL,
	"state" "reservation_state" DEFAULT 'active' NOT NULL,
	"journal_entry_id" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "reservations_amount_positive" CHECK (amount_base > 0),
	CONSTRAINT "reservations_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "reservations_scale_range" CHECK (asset_scale between 0 and 36),
	CONSTRAINT "reservations_window" CHECK (expires_at > occurred_at)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"entry_sequence" bigserial NOT NULL,
	"kind" "journal_entry_kind" NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"intent_id" text,
	"reverses_entry_id" text,
	CONSTRAINT "journal_entries_reversal_link" CHECK ((kind = 'reversal') = (reverses_entry_id is not null)),
	CONSTRAINT "journal_entries_no_self_reversal" CHECK (reverses_entry_id is null or reverses_entry_id <> entry_id)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"entry_id" text NOT NULL,
	"line_index" integer NOT NULL,
	"account_key" text NOT NULL,
	"account_family" "account_family" NOT NULL,
	"holdings_state" "holdings_state",
	"asset_id" text NOT NULL,
	"asset_scale" smallint NOT NULL,
	"direction" "posting_direction" NOT NULL,
	"amount_base" numeric(78, 0) NOT NULL,
	CONSTRAINT "journal_lines_entry_id_line_index_pk" PRIMARY KEY("entry_id","line_index"),
	CONSTRAINT "journal_lines_amount_positive" CHECK (amount_base > 0),
	CONSTRAINT "journal_lines_scale_range" CHECK (asset_scale between 0 and 36),
	CONSTRAINT "journal_lines_holdings_state" CHECK ((account_family = 'holdings') = (holdings_state is not null)),
	CONSTRAINT "journal_lines_line_index_non_negative" CHECK (line_index >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_balances" (
	"account_key" text PRIMARY KEY NOT NULL,
	"account_family" "account_family" NOT NULL,
	"holdings_state" "holdings_state",
	"asset_id" text NOT NULL,
	"asset_scale" smallint NOT NULL,
	"debit_base" numeric(78, 0) DEFAULT 0 NOT NULL,
	"credit_base" numeric(78, 0) DEFAULT 0 NOT NULL,
	"last_recorded_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "ledger_balances_totals_non_negative" CHECK (debit_base >= 0 and credit_base >= 0),
	CONSTRAINT "ledger_balances_holdings_never_negative" CHECK (account_family <> 'holdings' or debit_base >= credit_base),
	CONSTRAINT "ledger_balances_holdings_state" CHECK ((account_family = 'holdings') = (holdings_state is not null)),
	CONSTRAINT "ledger_balances_scale_range" CHECK (asset_scale between 0 and 36)
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_idempotency_key_key" ON "reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_intent_id_attempt_key" ON "reservations" USING btree ("intent_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_journal_entry_id_key" ON "reservations" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "reservations_correlation_id_idx" ON "reservations" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "reservations_state_expires_at_idx" ON "reservations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_entry_sequence_key" ON "journal_entries" USING btree ("entry_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_idempotency_key_key" ON "journal_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_entry_id_key" ON "journal_entries" USING btree ("reverses_entry_id");--> statement-breakpoint
CREATE INDEX "journal_entries_correlation_id_idx" ON "journal_entries" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_key_idx" ON "journal_lines" USING btree ("account_key");--> statement-breakpoint
CREATE INDEX "ledger_balances_asset_id_idx" ON "ledger_balances" USING btree ("asset_id");