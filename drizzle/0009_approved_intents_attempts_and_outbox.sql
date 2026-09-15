CREATE TYPE "public"."dispatch_state" AS ENUM('pending', 'dispatched', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."execution_attempt_state" AS ENUM('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'UNKNOWN', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "approved_intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"economic_action_id" text NOT NULL,
	"position_plan_id" text NOT NULL,
	"candidate_id" text,
	"operating_mode" text NOT NULL,
	"funding_account_id" text NOT NULL,
	"venue_id" text NOT NULL,
	"chain_id" text,
	"route_id" text,
	"input_asset_id" text NOT NULL,
	"input_asset_scale" smallint NOT NULL,
	"output_asset_id" text NOT NULL,
	"output_asset_scale" smallint NOT NULL,
	"quantity_base" numeric(78, 0) NOT NULL,
	"max_spend_base" numeric(78, 0) NOT NULL,
	"min_acceptable_receipt_base" numeric(78, 0) NOT NULL,
	"permitted_residual_base" numeric(78, 0) NOT NULL,
	"valid_until" timestamp (3) with time zone NOT NULL,
	"required_freshness_ms" integer NOT NULL,
	"protection_plan" text,
	"remaining_inventory_treatment" text NOT NULL,
	"benchmark_id" text,
	"approval_reason" text,
	"adapter_capability_version" text NOT NULL,
	"chain_simulation_id" text,
	"chain_simulation_passed" boolean,
	"approved_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"strategy_version" text NOT NULL,
	"model_version" text,
	"portfolio_snapshot_version" text NOT NULL,
	"market_snapshot_version" text NOT NULL,
	"fee_snapshot_version" text NOT NULL,
	CONSTRAINT "approved_intents_identity_present" CHECK (length(btrim(intent_id)) > 0 and length(btrim(idempotency_key)) > 0 and length(btrim(correlation_id)) > 0 and length(btrim(economic_action_id)) > 0),
	CONSTRAINT "approved_intents_amounts_authorize_something" CHECK (quantity_base > 0 and max_spend_base > 0 and min_acceptable_receipt_base >= 0 and permitted_residual_base >= 0 and permitted_residual_base <= max_spend_base),
	CONSTRAINT "approved_intents_scale_range" CHECK (input_asset_scale between 0 and 36 and output_asset_scale between 0 and 36),
	CONSTRAINT "approved_intents_window" CHECK (valid_until > approved_at),
	CONSTRAINT "approved_intents_freshness_positive" CHECK (required_freshness_ms > 0),
	CONSTRAINT "approved_intents_chain_validation_paired" CHECK ((chain_simulation_id is null) = (chain_simulation_passed is null)),
	CONSTRAINT "approved_intents_chain_simulated" CHECK (chain_id is null or chain_simulation_passed is true),
	CONSTRAINT "approved_intents_provenance_present" CHECK (length(btrim(policy_version)) > 0 and length(btrim(strategy_version)) > 0 and length(btrim(portfolio_snapshot_version)) > 0 and length(btrim(market_snapshot_version)) > 0 and length(btrim(fee_snapshot_version)) > 0)
);
--> statement-breakpoint
CREATE TABLE "execution_attempts" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"client_order_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"state" "execution_attempt_state" DEFAULT 'SUBMITTING' NOT NULL,
	"venue_order_id" text,
	"input_asset_scale" smallint NOT NULL,
	"output_asset_scale" smallint NOT NULL,
	"spent_base" numeric(78, 0) DEFAULT 0 NOT NULL,
	"received_base" numeric(78, 0) DEFAULT 0 NOT NULL,
	"submitted_at" timestamp (3) with time zone NOT NULL,
	"state_changed_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"reconciled_at" timestamp (3) with time zone,
	"reconciliation_id" text,
	CONSTRAINT "execution_attempts_intent_id_attempt_key" UNIQUE("intent_id","attempt"),
	CONSTRAINT "execution_attempts_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "execution_attempts_amounts_non_negative" CHECK (spent_base >= 0 and received_base >= 0),
	CONSTRAINT "execution_attempts_received_implies_spent" CHECK (received_base = 0 or spent_base > 0),
	CONSTRAINT "execution_attempts_scale_range" CHECK (input_asset_scale between 0 and 36 and output_asset_scale between 0 and 36),
	CONSTRAINT "execution_attempts_reconciliation_paired" CHECK ((reconciled_at is null) = (reconciliation_id is null)),
	CONSTRAINT "execution_attempts_instants_ordered" CHECK (state_changed_at >= submitted_at and (reconciled_at is null or reconciled_at >= submitted_at)),
	CONSTRAINT "execution_attempts_identity_present" CHECK (length(btrim(client_order_id)) > 0 and length(btrim(correlation_id)) > 0)
);
--> statement-breakpoint
CREATE TABLE "intent_dispatch_outbox" (
	"dispatch_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"state" "dispatch_state" DEFAULT 'pending' NOT NULL,
	"payload_digest" text NOT NULL,
	"dispatcher_instance_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"enqueued_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"dispatched_at" timestamp (3) with time zone,
	"abandonment_reason_code" text,
	CONSTRAINT "intent_dispatch_outbox_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "intent_dispatch_outbox_fencing_token_positive" CHECK (fencing_token > 0),
	CONSTRAINT "intent_dispatch_outbox_payload_digest_shape" CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "intent_dispatch_outbox_dispatched_at_paired" CHECK ((state = 'dispatched') = (dispatched_at is not null)),
	CONSTRAINT "intent_dispatch_outbox_abandonment_reasoned" CHECK ((state = 'abandoned') = (abandonment_reason_code is not null)),
	CONSTRAINT "intent_dispatch_outbox_instants_ordered" CHECK (dispatched_at is null or dispatched_at >= enqueued_at),
	CONSTRAINT "intent_dispatch_outbox_identity_present" CHECK (length(btrim(dispatch_id)) > 0 and length(btrim(correlation_id)) > 0 and length(btrim(dispatcher_instance_id)) > 0)
);
--> statement-breakpoint
ALTER TABLE "approved_intents" ADD CONSTRAINT "approved_intents_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_intents" ADD CONSTRAINT "approved_intents_input_asset_scale_fk" FOREIGN KEY ("input_asset_id","input_asset_scale") REFERENCES "public"."asset_scales"("asset_id","asset_scale") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_intents" ADD CONSTRAINT "approved_intents_output_asset_scale_fk" FOREIGN KEY ("output_asset_id","output_asset_scale") REFERENCES "public"."asset_scales"("asset_id","asset_scale") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."approved_intents"("intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_dispatch_outbox" ADD CONSTRAINT "intent_dispatch_outbox_attempt_fk" FOREIGN KEY ("intent_id","attempt") REFERENCES "public"."execution_attempts"("intent_id","attempt") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approved_intents_idempotency_key_key" ON "approved_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approved_intents_economic_action_id_key" ON "approved_intents" USING btree ("economic_action_id");--> statement-breakpoint
CREATE INDEX "approved_intents_correlation_id_idx" ON "approved_intents" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_client_order_id_key" ON "execution_attempts" USING btree ("client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_intent_id_live_key" ON "execution_attempts" USING btree ("intent_id") WHERE state in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_intent_id_consumed_key" ON "execution_attempts" USING btree ("intent_id") WHERE spent_base > 0;--> statement-breakpoint
CREATE INDEX "execution_attempts_correlation_id_idx" ON "execution_attempts" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_dispatch_outbox_intent_id_attempt_key" ON "intent_dispatch_outbox" USING btree ("intent_id","attempt");--> statement-breakpoint
CREATE INDEX "intent_dispatch_outbox_correlation_id_idx" ON "intent_dispatch_outbox" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "intent_dispatch_outbox_state_enqueued_at_idx" ON "intent_dispatch_outbox" USING btree ("state","enqueued_at");