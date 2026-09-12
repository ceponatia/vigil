import type { HoldingsState, LedgerAccount } from "../accounts";
import { rebuildBalances, type BalanceSheet } from "../balances";
import { buildEntry, type EntryKind, type EntryProvenance, type JournalEntry } from "../journal";
import type { ReleaseRequest, ReservationRequest } from "../reservations";
import { assetIdentitySchema, canonicalAssetId, isoUtcTimestampSchema, type AssetId, type IsoUtcTimestamp } from "@vigil/contracts";

/**
 * Builders for this package's own suites only. Never imported by production
 * code, and never exported from `src/index.ts`.
 *
 * Every identifier here is obviously synthetic. The asset ids are canonical
 * four-component identities, as production ones are, but on chain `1337` —
 * the id this codebase reserves for the synthetic test chain — with
 * denominations no real chain issues. No address, key, or holding of any
 * kind appears here.
 */

/**
 * Derived through `canonicalAssetId` rather than written out as a string,
 * so a fixture cannot name an asset the application could not have produced
 * — and so these ids are canonical by construction rather than by the
 * author having typed the four components in the right order.
 */
function syntheticAsset(denomination: string): AssetId {
  return canonicalAssetId(
    assetIdentitySchema.parse({
      kind: "native",
      chainId: "1337",
      nativeDenomination: denomination,
      withdrawalNetwork: "SYNTHETIC_TESTNET",
    }),
  );
}

/** A synthetic six-decimal settlement asset. */
export const TEST_STABLE_ASSET = syntheticAsset("VGLSTABLE");
export const TEST_STABLE_SCALE = 6;

/** A synthetic eighteen-decimal asset, to keep scale handling honest. */
export const TEST_VOLATILE_ASSET = syntheticAsset("VGLVOLATILE");
export const TEST_VOLATILE_SCALE = 18;

/**
 * The provenance a fixture record carries. Deterministic and obviously
 * synthetic; `modelVersion` is null because no LLM is involved in any path
 * this package has.
 */
export const TEST_PROVENANCE: EntryProvenance = {
  policyVersion: "policy-test-0",
  strategyVersion: "strategy-test-0",
  modelVersion: null,
  portfolioSnapshotVersion: null,
  marketSnapshotVersion: null,
};

/** Parse a literal into a validated timestamp. Time is always an input. */
export function at(value: string): IsoUtcTimestamp {
  return isoUtcTimestampSchema.parse(value);
}

export type TwoLineEntryInput = {
  readonly entryId: string;
  readonly kind: EntryKind;
  readonly debit: LedgerAccount;
  readonly credit: LedgerAccount;
  readonly amountBase: bigint;
  readonly scale?: number;
  readonly occurredAt?: string;
  readonly recordedAt?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly intentId?: string | null;
  readonly reversesEntryId?: string | null;
  readonly provenance?: EntryProvenance;
};

/**
 * Build a balanced two-line entry, or throw. A refusal here is a defect in
 * the test's own setup, not schema-legal production input, so throwing is
 * the right signal — production paths still get a diagnostic.
 */
export function twoLineEntry(input: TwoLineEntryInput): JournalEntry {
  const scale = input.scale ?? TEST_STABLE_SCALE;
  const result = buildEntry({
    entryId: input.entryId,
    kind: input.kind,
    occurredAt: at(input.occurredAt ?? "2026-01-02T03:04:05.000Z"),
    recordedAt: at(input.recordedAt ?? "2026-01-02T03:04:06.000Z"),
    correlationId: input.correlationId ?? `corr-${input.entryId}`,
    idempotencyKey: input.idempotencyKey ?? `idem-${input.entryId}`,
    intentId: input.intentId ?? null,
    reversesEntryId: input.reversesEntryId ?? null,
    provenance: input.provenance ?? TEST_PROVENANCE,
    lines: [
      { account: input.debit, scale, amountBase: input.amountBase, direction: "debit" },
      { account: input.credit, scale, amountBase: input.amountBase, direction: "credit" },
    ],
  });

  if (result.outcome === "refused") {
    throw new Error(`test fixture built an invalid entry: ${result.refusal.reason.code} — ${result.refusal.detail}`);
  }
  return result.entry;
}

/**
 * Rebuild a balance sheet from entries, or throw. Tests that need a starting
 * balance state build it the same way the application does — by replaying
 * the journal — rather than by hand-assembling a map the journal would never
 * have produced.
 */
export function sheetFrom(entries: readonly JournalEntry[]): BalanceSheet {
  const rebuilt = rebuildBalances(entries);
  if (rebuilt.outcome === "refused") {
    throw new Error(`test fixture journal did not rebuild: ${rebuilt.refusal.reason.code} — ${rebuilt.refusal.detail}`);
  }
  return rebuilt.balances;
}

export type ReservationRequestInput = {
  readonly amountBase: bigint;
  readonly reservationId?: string;
  readonly entryId?: string;
  readonly intentId?: string;
  readonly attempt?: number;
  readonly assetId?: AssetId;
  readonly scale?: number;
  readonly fromState?: HoldingsState;
  readonly occurredAt?: string;
  readonly expiresAt?: string;
};

export function reservationRequest(input: ReservationRequestInput): ReservationRequest {
  const reservationId = input.reservationId ?? "reservation-1";
  return {
    reservationId,
    intentId: input.intentId ?? `intent-${reservationId}`,
    attempt: input.attempt ?? 1,
    idempotencyKey: `idem-${reservationId}`,
    correlationId: `corr-${reservationId}`,
    entryId: input.entryId ?? `entry-${reservationId}`,
    assetId: input.assetId ?? TEST_STABLE_ASSET,
    scale: input.scale ?? TEST_STABLE_SCALE,
    amountBase: input.amountBase,
    fromState: input.fromState ?? "available",
    occurredAt: at(input.occurredAt ?? "2026-01-02T03:04:05.000Z"),
    recordedAt: at("2026-01-02T03:04:06.000Z"),
    expiresAt: at(input.expiresAt ?? "2026-01-02T03:09:05.000Z"),
    provenance: TEST_PROVENANCE,
  };
}

export type ReleaseRequestInput = {
  readonly amountBase: bigint;
  readonly reservationId?: string;
  readonly entryId?: string;
  readonly assetId?: AssetId;
  readonly scale?: number;
};

export function releaseRequest(input: ReleaseRequestInput): ReleaseRequest {
  const reservationId = input.reservationId ?? "reservation-1";
  const entryId = input.entryId ?? `entry-release-${reservationId}`;
  return {
    reservationId,
    intentId: `intent-${reservationId}`,
    idempotencyKey: `idem-${entryId}`,
    correlationId: `corr-${reservationId}`,
    entryId,
    assetId: input.assetId ?? TEST_STABLE_ASSET,
    scale: input.scale ?? TEST_STABLE_SCALE,
    amountBase: input.amountBase,
    occurredAt: at("2026-01-02T03:06:05.000Z"),
    recordedAt: at("2026-01-02T03:06:06.000Z"),
    provenance: TEST_PROVENANCE,
  };
}
