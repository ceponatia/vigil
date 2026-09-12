CREATE TABLE "asset_scales" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"asset_scale" smallint NOT NULL,
	CONSTRAINT "asset_scales_asset_id_asset_scale_key" UNIQUE("asset_id","asset_scale"),
	CONSTRAINT "asset_scales_scale_range" CHECK (asset_scale between 0 and 36),
	CONSTRAINT "asset_scales_canonical_asset_id" CHECK (asset_id ~ '^[^|/]+[|](contract|mint|native)[|][^|/]+[|][^|/]+$')
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "policy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "strategy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "portfolio_snapshot_version" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "market_snapshot_version" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "policy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "strategy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "portfolio_snapshot_version" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "market_snapshot_version" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_asset_scale_fk" FOREIGN KEY ("asset_id","asset_scale") REFERENCES "public"."asset_scales"("asset_id","asset_scale") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_asset_scale_fk" FOREIGN KEY ("asset_id","asset_scale") REFERENCES "public"."asset_scales"("asset_id","asset_scale") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_balances" ADD CONSTRAINT "ledger_balances_asset_scale_fk" FOREIGN KEY ("asset_id","asset_scale") REFERENCES "public"."asset_scales"("asset_id","asset_scale") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_provenance_present" CHECK (length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_provenance_present" CHECK (length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0);