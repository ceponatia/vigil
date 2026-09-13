CREATE TYPE "public"."candidate_horizon" AS ENUM('intraday', 'swing', 'position');--> statement-breakpoint
CREATE TYPE "public"."candidate_outcome" AS ENUM('ENTRY_ELIGIBLE', 'WAIT', 'MISSED', 'BLOCKED');--> statement-breakpoint
CREATE TABLE "candidate_evaluations" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"candidate_id" text NOT NULL,
	"outcome" "candidate_outcome" NOT NULL,
	"reason_code" text,
	"detail" text NOT NULL,
	"executable_price" text,
	"quote_acquired_at" timestamp (3) with time zone,
	"evaluated_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "candidate_evaluations_executable_price_decimal" CHECK ((executable_price is null or executable_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$'))
);
--> statement-breakpoint
CREATE TABLE "candidate_tranches" (
	"candidate_id" text NOT NULL,
	"tranche_index" integer NOT NULL,
	"quantity" text NOT NULL,
	"trigger_price" text,
	CONSTRAINT "candidate_tranches_candidate_id_tranche_index_pk" PRIMARY KEY("candidate_id","tranche_index"),
	CONSTRAINT "candidate_tranches_index_non_negative" CHECK (tranche_index >= 0),
	CONSTRAINT "candidate_tranches_amounts_decimal" CHECK (quantity ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and (trigger_price is null or trigger_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$'))
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"candidate_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"action" text NOT NULL,
	"action_detail" text NOT NULL,
	"horizon" "candidate_horizon" NOT NULL,
	"entry_zone_min" text NOT NULL,
	"entry_zone_max" text NOT NULL,
	"allowed_extension" text NOT NULL,
	"invalidation_price" text NOT NULL,
	"invalidation_conditions" text[] NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"benchmark_id" text NOT NULL,
	"quote_acquired_at" timestamp (3) with time zone NOT NULL,
	"quote_ingested_at" timestamp (3) with time zone NOT NULL,
	"bid_price" text NOT NULL,
	"ask_price" text NOT NULL,
	"generated_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"strategy_version" text NOT NULL,
	"model_version" text,
	"portfolio_snapshot_version" text,
	"market_snapshot_version" text,
	CONSTRAINT "candidates_instrument_id_canonical" CHECK (instrument_id ~ '^[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+/[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+$'),
	CONSTRAINT "candidates_prices_decimal" CHECK (entry_zone_min ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and entry_zone_max ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and allowed_extension ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and invalidation_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and bid_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and ask_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$'),
	CONSTRAINT "candidates_provenance_present" CHECK (length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0)
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"heartbeat_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process" text NOT NULL,
	"instance_id" text NOT NULL,
	"operating_mode" text NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"last_quote_acquired_at" timestamp (3) with time zone,
	"detail" text,
	CONSTRAINT "heartbeats_identity_present" CHECK (length(btrim(process)) > 0 and length(btrim(instance_id)) > 0)
);
--> statement-breakpoint
ALTER TABLE "candidate_evaluations" ADD CONSTRAINT "candidate_evaluations_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_tranches" ADD CONSTRAINT "candidate_tranches_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_evaluations_idempotency_key_key" ON "candidate_evaluations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "candidate_evaluations_candidate_id_evaluated_at_idx" ON "candidate_evaluations" USING btree ("candidate_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_idempotency_key_key" ON "candidates" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "candidates_correlation_id_idx" ON "candidates" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "candidates_generated_at_idx" ON "candidates" USING btree ("generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeats_process_instance_id_observed_at_key" ON "heartbeats" USING btree ("process","instance_id","observed_at");