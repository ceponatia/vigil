import { operatingModeSchema } from "@vigil/contracts";
import type { OperatingMode } from "@vigil/contracts";

import { ORDER_STATES } from "./order-state";
import type { OrderState } from "./order-state";

/**
 * capability.ts — what this adapter declares it can do, and the version
 * stamp an `ApprovedEconomicIntent.adapterCapabilityVersion` must name for
 * this build to act on it (`docs/architecture.md` "Contracts").
 *
 * The stamp is a gate, not a label. An intent approved against a different
 * adapter capability — a different fee model, a different fill semantics, a
 * venue this build does not simulate — is refused rather than executed
 * under assumptions the approval never made. Change any behavior a caller
 * could have relied on when sizing or approving an intent and this version
 * changes with it; an intent stamped with the old one then refuses instead
 * of silently executing against new rules.
 *
 * `mode` is parsed through `@vigil/contracts`' own registry rather than
 * typed as a bare string, so the one mode this adapter can ever report is
 * a real member of that registry. It is `PAPER` permanently: this package
 * holds no credential, performs no signing, and reaches no endpoint, and
 * `docs/policy.md` puts LIVE behind a capability gate no code here can
 * open.
 */

export const PAPER_ADAPTER_ID = "paper";

export const PAPER_ADAPTER_CAPABILITY_VERSION = "paper-exchange-1";

/**
 * The faults a caller may inject through `PaperExchangeConfig`. This list
 * is part of the capability because it is the contract the repository's
 * fault-injection suites are written against (`docs/testing.md`
 * "Idempotency and recovery"): a scenario names the fault it drives, and
 * this adapter declares which ones it can actually produce.
 */
export const INJECTABLE_FAULTS = [
  /** The submission response is lost and the venue never accepted the order. */
  "SUBMISSION_TIMEOUT_BEFORE_ACCEPTANCE",
  /** The venue accepted the order but the caller never observed the acknowledgement. */
  "SUBMISSION_TIMEOUT_AFTER_ACCEPTANCE",
  /** The venue confirms a rejection. */
  "CONFIRMED_REJECTION",
  /** The venue confirms an expiry. */
  "CONFIRMED_EXPIRY",
  /** The order fills in more than one execution. */
  "PARTIAL_FILL",
  /** The order is acknowledged and rests without filling. */
  "NO_FILL",
  /** The cancellation response is lost; the venue itself did cancel. */
  "CANCELLATION_TIMEOUT",
  /** The venue expires a resting order without being asked. */
  "VENUE_INITIATED_EXPIRY",
  /** The venue rejects an order it had already acknowledged. */
  "VENUE_INITIATED_REJECTION",
  /** The venue cancels a resting order itself — a cancel-on-disconnect. */
  "VENUE_INITIATED_CANCELLATION",
  /** The reconciliation read cannot see the whole venue, so it resolves nothing. */
  "INCOMPLETE_RECONCILIATION_READ",
] as const;

export type InjectableFault = (typeof INJECTABLE_FAULTS)[number];

export type AdapterCapability = {
  readonly adapterId: string;
  readonly capabilityVersion: string;
  readonly mode: OperatingMode;
  /** Permanently false, and asserted by this package's own source-level test. */
  readonly reachesLiveEndpoint: false;
  readonly holdsVenueCredential: false;
  readonly canSignTransactions: false;
  readonly supportedOrderStates: readonly OrderState[];
  readonly supportsPartialFill: true;
  readonly supportsCancellation: true;
  readonly supportsReconciliation: true;
  readonly injectableFaults: readonly InjectableFault[];
};

export const PAPER_ADAPTER_CAPABILITY: AdapterCapability = {
  adapterId: PAPER_ADAPTER_ID,
  capabilityVersion: PAPER_ADAPTER_CAPABILITY_VERSION,
  mode: operatingModeSchema.parse("PAPER"),
  reachesLiveEndpoint: false,
  holdsVenueCredential: false,
  canSignTransactions: false,
  supportedOrderStates: ORDER_STATES,
  supportsPartialFill: true,
  supportsCancellation: true,
  supportsReconciliation: true,
  injectableFaults: INJECTABLE_FAULTS,
};
