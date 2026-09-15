CREATE TABLE "position_plans" (
	"position_plan_id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"entry_zone_min" text NOT NULL,
	"entry_zone_max" text NOT NULL,
	"thesis_exit_price" text NOT NULL,
	"formation_reference_mid" text NOT NULL,
	"formed_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"strategy_version" text NOT NULL,
	"model_version" text,
	"portfolio_snapshot_version" text,
	"market_snapshot_version" text,
	CONSTRAINT "position_plans_instrument_id_canonical" CHECK (instrument_id ~ '^[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+/[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+$'),
	CONSTRAINT "position_plans_prices_decimal" CHECK (entry_zone_min ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and entry_zone_max ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and thesis_exit_price ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$' and formation_reference_mid ~ '^(0([.]0+)?|[1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$'),
	CONSTRAINT "position_plans_identity_present" CHECK (length(btrim(position_plan_id)) > 0 and length(btrim(correlation_id)) > 0),
	CONSTRAINT "position_plans_provenance_present" CHECK (length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0),
	CONSTRAINT "position_plans_recorded_after_formation" CHECK (recorded_at >= formed_at)
);
--> statement-breakpoint
CREATE INDEX "position_plans_correlation_id_idx" ON "position_plans" USING btree ("correlation_id");