import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp } from "@vigil/contracts";
import { loadBalances, loadCandidates, loadJournalEntries, loadLatestHeartbeats, reservations } from "@vigil/db";
import type { VigilDatabase } from "@vigil/db";

import type { ControlConfig } from "./env";
import { getDb } from "./db";
import { deriveCandidateValidity } from "./candidates";
import { summarizeCosts } from "./costs";
import { formatBaseUnits } from "./format";
import { deriveRuntimeHealth, HEARTBEAT_STALE_AFTER_MS, QUOTE_STALE_AFTER_MS } from "./health";
import { groupHoldings } from "./holdings";

/**
 * data.ts — the ONLY module in apps/control that imports a `@vigil/db`
 * store function (BOOT-07 brief, "Interface contract"). Everything the page
 * renders is a plain, already-formatted view model built here; `src/app/`
 * stays thin and never imports `@vigil/db` itself.
 *
 * `loadCandidates` and `loadLatestHeartbeats` are pinned exports the
 * concurrent db slice has not landed yet on this branch — `tsc` fails here
 * until the parent merges that slice in, which is expected (BOOT-07
 * brief). Confining the two names to this one file is what keeps a small
 * signature drift a one-file fix.
 */

const AUDIT_TRAIL_LIMIT = 50;

export type HoldingsView = {
  readonly assetId: string;
  readonly states: ReadonlyArray<{ readonly state: string; readonly amount: string }>;
  readonly total: string;
};

export type CostView = { readonly assetId: string; readonly total: string };

export type ReservationView = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly assetId: string;
  readonly amount: string;
  readonly expiresAt: string;
  readonly correlationId: string;
};

export type CandidateView = {
  readonly candidateId: string;
  readonly instrumentId: string;
  readonly entryZone: string;
  readonly expiresAt: string;
  readonly validityState: string;
  readonly reasonCode: string | null;
  readonly latestEvaluationAt: string | null;
};

export type AuditEntryView = {
  readonly entryId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly intentId: string | null;
  readonly policyVersion: string;
  readonly strategyVersion: string;
  readonly modelVersion: string | null;
};

export type RuntimeInstanceView = {
  readonly process: string;
  readonly instanceId: string;
  readonly mode: string;
  readonly heartbeatStatus: string;
  readonly heartbeatAgeMs: number | null;
  readonly quoteStatus: string;
  readonly quoteAgeMs: number | null;
  readonly detail: string | null;
};

export type DashboardData = {
  readonly holdings: readonly HoldingsView[];
  readonly costs: readonly CostView[];
  readonly reservations: readonly ReservationView[];
  readonly candidates: readonly CandidateView[];
  readonly auditTrail: readonly AuditEntryView[];
  readonly runtimeHealth: { readonly instances: readonly RuntimeInstanceView[]; readonly paused: boolean };
};

export type DashboardErrorCode = "CLOCK_ERROR" | "DB_UNAVAILABLE";

export type DashboardResult =
  | { readonly outcome: "ok"; readonly data: DashboardData }
  | { readonly outcome: "error"; readonly code: DashboardErrorCode; readonly detail: string };

function nowTimestamp(): IsoUtcTimestamp | null {
  const parsed = isoUtcTimestampSchema.safeParse(new Date().toISOString());
  return parsed.success ? parsed.data : null;
}

type ActiveReservationRow = {
  readonly reservationId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly assetId: string;
  readonly assetScale: number;
  readonly amountBase: bigint;
  readonly expiresAt: string;
  readonly correlationId: string;
};

/**
 * Reads the `reservations` table directly rather than through
 * `loadActiveReservations` (`packages/db/src/store/reservation-store.ts`):
 * that function takes one `assetId` at a time and returns only
 * `{reservationId, amountBase, intentId}`, but this dashboard's
 * Reservations section shows every active reservation across every asset
 * with its attempt number and expiry (BOOT-07 brief, "Design"). Reading the
 * schema table `@vigil/db` already exports is an ordinary Postgres read,
 * not a change to `packages/db` — apps/control still decides nothing and
 * writes nothing.
 */
async function loadActiveReservationRows(db: VigilDatabase): Promise<readonly ActiveReservationRow[]> {
  const rows = await db.select().from(reservations);
  return rows
    .filter((row) => row.state === "active")
    .map(
      (row): ActiveReservationRow => ({
        reservationId: row.reservationId,
        intentId: row.intentId,
        attempt: row.attempt,
        assetId: row.assetId,
        assetScale: row.assetScale,
        amountBase: row.amountBase,
        expiresAt: row.expiresAt.toISOString(),
        correlationId: row.correlationId,
      }),
    )
    .toSorted((left, right) => (left.expiresAt < right.expiresAt ? -1 : left.expiresAt > right.expiresAt ? 1 : 0));
}

export async function loadDashboardData(config: ControlConfig): Promise<DashboardResult> {
  const now = nowTimestamp();
  if (now === null) {
    return {
      outcome: "error",
      code: "CLOCK_ERROR",
      detail: "the system clock did not produce a valid ISO-8601 timestamp",
    };
  }

  const db = getDb(config.databaseUrl);

  try {
    const [balances, journalEntries, candidates, heartbeats, activeReservations] = await Promise.all([
      loadBalances(db),
      loadJournalEntries(db),
      loadCandidates(db),
      loadLatestHeartbeats(db),
      loadActiveReservationRows(db),
    ]);

    const holdings: readonly HoldingsView[] = groupHoldings(balances).map((group) => ({
      assetId: group.assetId,
      states: group.states.map((item) => ({ state: item.state, amount: formatBaseUnits(item.netBase, group.assetScale) })),
      total: formatBaseUnits(group.totalBase, group.assetScale),
    }));

    const costs: readonly CostView[] = summarizeCosts(balances).map((cost) => ({
      assetId: cost.assetId,
      total: formatBaseUnits(cost.totalBase, cost.assetScale),
    }));

    const reservationViews: readonly ReservationView[] = activeReservations.map((row) => ({
      reservationId: row.reservationId,
      intentId: row.intentId,
      attempt: row.attempt,
      assetId: row.assetId,
      amount: formatBaseUnits(row.amountBase, row.assetScale),
      expiresAt: row.expiresAt,
      correlationId: row.correlationId,
    }));

    const candidateViews: readonly CandidateView[] = candidates.map((candidate) => {
      const validity = deriveCandidateValidity(candidate, now);
      return {
        candidateId: candidate.candidateId,
        instrumentId: candidate.instrumentId,
        entryZone: `${candidate.entryZoneMin} – ${candidate.entryZoneMax}`,
        expiresAt: candidate.expiresAt,
        validityState: validity.state,
        reasonCode: validity.reasonCode,
        latestEvaluationAt: candidate.latestEvaluation?.evaluatedAt ?? null,
      };
    });

    const auditTrail: readonly AuditEntryView[] = journalEntries
      .slice(-AUDIT_TRAIL_LIMIT)
      .toReversed()
      .map((entry) => ({
        entryId: entry.entryId,
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        correlationId: entry.correlationId,
        intentId: entry.intentId,
        policyVersion: entry.provenance.policyVersion,
        strategyVersion: entry.provenance.strategyVersion,
        modelVersion: entry.provenance.modelVersion,
      }));

    const health = deriveRuntimeHealth({
      heartbeats,
      now,
      heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      quoteStaleAfterMs: QUOTE_STALE_AFTER_MS,
      dashboardMode: config.mode,
    });

    return {
      outcome: "ok",
      data: {
        holdings,
        costs,
        reservations: reservationViews,
        candidates: candidateViews,
        auditTrail,
        runtimeHealth: {
          instances: health.instances.map((instance) => ({
            process: instance.process,
            instanceId: instance.instanceId,
            mode: instance.mode,
            heartbeatStatus: instance.heartbeat,
            heartbeatAgeMs: instance.heartbeatAgeMs,
            quoteStatus: instance.quote,
            quoteAgeMs: instance.quoteAgeMs,
            detail: instance.detail,
          })),
          paused: health.paused,
        },
      },
    };
  } catch (error) {
    return {
      outcome: "error",
      code: "DB_UNAVAILABLE",
      detail: error instanceof Error ? error.message : "an unknown error occurred while reading the database",
    };
  }
}
