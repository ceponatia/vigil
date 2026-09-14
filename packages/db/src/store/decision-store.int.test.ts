import { REASON_CODES } from "@vigil/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { candidateEvaluations, candidates, candidateTranches } from "../schema/decisions";
import {
  loadCandidates,
  recordCandidate,
  recordCandidateEvaluation,
  type StoreCandidateEvaluation,
} from "./decision-store";
import { postgresErrorCode, PG_RAISE_EXCEPTION } from "./pg-errors";
import { storeCandidate, storeEvaluation } from "../test-support/decision-fixtures";
import { openLedgerTestDb } from "../test-support/journal-fixtures";

// The defects this file kills, all of them about what the opportunity
// journal still says once the outcome is known:
//   * the same generated candidate recorded twice, so one decision counts
//     as two in every later comparison;
//   * an outcome persisted for a candidate nobody wrote down — the exact
//     shape of an opportunity journal that only contains the trades that
//     worked (docs/evaluation.md "Opportunity journal");
//   * a reason code or a price that never passed a registry or a decimal
//     check landing in a durable decision record;
//   * a candidate edited after the price moved, turning a missed entry into
//     a BUY the application never actually made.
//
// The real-infrastructure facts required are the NOT NULL foreign key from
// an evaluation to its candidate, the unique idempotency keys, the check
// constraints, and the append-only trigger. An in-memory double would delete
// these claims rather than move them.

const { db, close, reset } = openLedgerTestDb("vigil-decision-store-test");

afterAll(close);
beforeEach(reset);

async function storedEvaluationCount(): Promise<number> {
  return (await db.select().from(candidateEvaluations)).length;
}

async function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("recordCandidate", () => {
  it("records once when the same candidate is delivered twice under a fresh candidate id, and reports the candidate already stored — catches an at-least-once producer that doubles one decision in every later comparison, and a duplicate check keyed on the candidate id, which a regenerated id defeats", async () => {
    const first = await recordCandidate(db, storeCandidate("cand-once"));
    const redelivered = await recordCandidate(
      db,
      storeCandidate("cand-once-retry", { idempotencyKey: "idem-cand-once" }),
    );

    expect(first.outcome).toBe("recorded");
    expect(redelivered.outcome).toBe("duplicate");
    if (redelivered.outcome === "duplicate") {
      expect(redelivered.candidateId).toBe("cand-once");
    }
    expect(await loadCandidates(db)).toHaveLength(1);
  });

  it("refuses a candidate id that is already stored under a different idempotency key, rather than answering duplicate — catches the swallowed-candidate bug where a producer that regenerates ids after a restart is told its new decision was already persisted when nothing was written", async () => {
    expect((await recordCandidate(db, storeCandidate("cand-collide"))).outcome).toBe("recorded");

    const collision = await recordCandidate(
      db,
      storeCandidate("cand-collide", { idempotencyKey: "idem-cand-collide-second", entryZoneMin: "1.00" }),
    );

    expect(collision.outcome).toBe("refused");
    if (collision.outcome === "refused") {
      expect(collision.code).toBe("DUPLICATE_RECORD");
    }
    const stored = await loadCandidates(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.entryZoneMin).toBe("100.00");
  });

  it("refuses a price that is not a non-negative decimal string and writes nothing — catches a float or a toFixed() artifact reaching a durable decision record, which is the money rule this package exists to make unbreakable", async () => {
    const exponent = await recordCandidate(db, storeCandidate("cand-float", { entryZoneMax: "1.04e2" }));
    const negative = await recordCandidate(db, storeCandidate("cand-negative", { invalidationPrice: "-92.00" }));
    const trancheAmount = await recordCandidate(
      db,
      storeCandidate("cand-tranche-float", { tranches: [{ index: 0, quantity: "1.5", triggerPrice: "1e-3" }] }),
    );

    for (const result of [exponent, negative, trancheAmount]) {
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.code).toBe("INVALID_DECIMAL");
      }
    }
    expect(await loadCandidates(db)).toEqual([]);
  });

  it("refuses a plan with no tranches and a plan whose tranches are not indexed 0..n-1 — catches a staged position plan persisted with a tranche missing, where the plan that is replayed is not the plan that was decided", async () => {
    const empty = await recordCandidate(db, storeCandidate("cand-empty", { tranches: [] }));
    const gapped = await recordCandidate(
      db,
      storeCandidate("cand-gap", {
        tranches: [
          { index: 0, quantity: "1", triggerPrice: null },
          { index: 2, quantity: "1", triggerPrice: null },
        ],
      }),
    );

    expect(empty.outcome).toBe("refused");
    if (empty.outcome === "refused") {
      expect(empty.code).toBe("EMPTY_PLAN");
    }
    expect(gapped.outcome).toBe("refused");
    if (gapped.outcome === "refused") {
      expect(gapped.code).toBe("INVALID_PLAN");
    }
    expect(await loadCandidates(db)).toEqual([]);
  });

  it("refuses an instrument id that is not two canonical asset ids — catches a ticker pair reaching a decision record, where two different assets that display the same symbol are silently merged", async () => {
    const refused = await recordCandidate(db, storeCandidate("cand-ticker", { instrumentId: "BTC-USD" }));

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.code).toBe("INVALID_INSTRUMENT");
    }
    expect(await loadCandidates(db)).toEqual([]);
  });

  it("rejects an UPDATE and a DELETE against a stored candidate and against its tranches, leaving both as written — catches a later slice rewriting the entry zone or resizing a tranche once the price has moved, which is how a missed entry becomes a BUY the application never made; both of migration 0008's triggers are asserted, because a plan that can be rewritten is a rewritten plan even when its candidate is sealed", async () => {
    expect((await recordCandidate(db, storeCandidate("cand-sealed"))).outcome).toBe("recorded");

    const candidateUpdate = await errorFrom(() =>
      db.execute(sql`update ${candidates} set entry_zone_max = '999.00' where candidate_id = 'cand-sealed'`),
    );
    const candidateDelete = await errorFrom(() =>
      db.execute(sql`delete from ${candidates} where candidate_id = 'cand-sealed'`),
    );
    const trancheUpdate = await errorFrom(() =>
      db.execute(sql`update ${candidateTranches} set quantity = '999' where candidate_id = 'cand-sealed'`),
    );
    const trancheDelete = await errorFrom(() =>
      db.execute(sql`delete from ${candidateTranches} where candidate_id = 'cand-sealed'`),
    );

    for (const failure of [candidateUpdate, candidateDelete, trancheUpdate, trancheDelete]) {
      expect(postgresErrorCode(failure)).toBe(PG_RAISE_EXCEPTION);
    }
    const stored = await loadCandidates(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.entryZoneMax).toBe("104.00");
    expect(stored[0]?.tranches.map((tranche) => tranche.quantity)).toEqual(["1.5", "2.5"]);
  });

  it("refuses a candidate that leaves an identity field blank and writes nothing — catches a blank correlation id satisfying NOT NULL and taking the one row every other unnamed candidate then collides with, after which no intent, attempt or outcome can be traced back to the decision that produced it", async () => {
    const blankCorrelation = await recordCandidate(db, storeCandidate("cand-unnamed", { correlationId: "   " }));

    expect(blankCorrelation.outcome).toBe("refused");
    if (blankCorrelation.outcome === "refused") {
      expect(blankCorrelation.code).toBe("EMPTY_IDENTITY");
    }
    expect(await loadCandidates(db)).toEqual([]);
  });
});

describe("recordCandidateEvaluation", () => {
  it("refuses an outcome for a candidate that is not in durable history and writes nothing — this is the 'every candidate is logged before any outcome is known' guarantee: an opportunity journal that accepts an orphan outcome is one that can contain only the decisions that worked", async () => {
    const orphan = await recordCandidateEvaluation(db, storeEvaluation("eval-orphan", "cand-never-written"));

    expect(orphan.outcome).toBe("refused");
    if (orphan.outcome === "refused") {
      expect(orphan.code).toBe("UNKNOWN_CANDIDATE");
    }
    expect(await storedEvaluationCount()).toBe(0);
  });

  it("refuses a reason code that is not in the REASON_CODES registry and writes nothing — catches an ad hoc or provider-supplied string reaching a durable refusal record, where the vocabulary docs/policy.md owns stops being the vocabulary the data uses", async () => {
    expect((await recordCandidate(db, storeCandidate("cand-reasoned"))).outcome).toBe("recorded");
    const invented = "PRICE_TOO_HIGH";
    expect(REASON_CODES).not.toContain(invented);

    const refused = await recordCandidateEvaluation(
      db,
      storeEvaluation("eval-invented", "cand-reasoned", { reasonCode: invented }),
    );

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.code).toBe("INVALID_REASON_CODE");
    }
    expect(await storedEvaluationCount()).toBe(0);
  });

  it("records a BLOCKED outcome that carries no executable price — catches a store that demands a price to write an outcome at all, which would leave a corrupt or stale quote with no record of having blocked anything", async () => {
    expect((await recordCandidate(db, storeCandidate("cand-blocked"))).outcome).toBe("recorded");

    const blocked = await recordCandidateEvaluation(
      db,
      storeEvaluation("eval-blocked", "cand-blocked", {
        outcome: "BLOCKED",
        reasonCode: "STALE_QUOTE",
        executablePrice: null,
        quoteAcquiredAt: null,
      }),
    );

    expect(blocked.outcome).toBe("recorded");
    const stored = await loadCandidates(db);
    expect(stored[0]?.latestEvaluation?.outcome).toBe("BLOCKED");
    expect(stored[0]?.latestEvaluation?.executablePrice).toBeNull();
  });
});

describe("loadCandidates", () => {
  it("returns candidates newest first, each plan in index order, and only the newest evaluation per candidate — catches a plan read back in insertion order (a staged entry worked out of sequence) and a dashboard that renders a superseded WAIT as the current state of a candidate that has since been missed", async () => {
    const older = storeCandidate("cand-older", {
      generatedAt: "2026-01-02T03:04:06.000Z",
      tranches: [
        { index: 1, quantity: "2.5", triggerPrice: "99.00" },
        { index: 0, quantity: "1.5", triggerPrice: null },
      ],
    });
    const newer = storeCandidate("cand-newer", { generatedAt: "2026-01-02T05:00:00.000Z" });
    expect((await recordCandidate(db, older)).outcome).toBe("recorded");
    expect((await recordCandidate(db, newer)).outcome).toBe("recorded");

    const superseded: StoreCandidateEvaluation = storeEvaluation("eval-wait", "cand-older", {
      outcome: "WAIT",
      evaluatedAt: "2026-01-02T03:10:01.000Z",
    });
    const current: StoreCandidateEvaluation = storeEvaluation("eval-missed", "cand-older", {
      outcome: "MISSED",
      reasonCode: "OUTSIDE_ENTRY_ZONE",
      evaluatedAt: "2026-01-02T04:10:01.000Z",
    });
    expect((await recordCandidateEvaluation(db, superseded)).outcome).toBe("recorded");
    expect((await recordCandidateEvaluation(db, current)).outcome).toBe("recorded");

    const stored = await loadCandidates(db);

    expect(stored.map((candidate) => candidate.candidateId)).toEqual(["cand-newer", "cand-older"]);
    const olderStored = stored.find((candidate) => candidate.candidateId === "cand-older");
    expect(olderStored?.tranches.map((tranche) => tranche.index)).toEqual([0, 1]);
    expect(olderStored?.tranches.map((tranche) => tranche.quantity)).toEqual(["1.5", "2.5"]);
    expect(olderStored?.latestEvaluation?.evaluationId).toBe("eval-missed");
    expect(stored.find((candidate) => candidate.candidateId === "cand-newer")?.latestEvaluation).toBeNull();
  });

  it("round-trips every stored field as the same value the producer supplied — catches a timestamp read back as a different instant, a decimal reformatted on the way through, or an invalidation condition dropped, any of which makes a replay disagree with the decision it replays. Spelling is not preserved and is not claimed: a timestamp comes back from `Date#toISOString`, so `…:05Z` returns as `…:05.000Z` — the same instant, written out one way", async () => {
    const candidate = storeCandidate("cand-roundtrip", {
      invalidationConditions: ["closes below the prior swing low", "funding turns negative for two sessions"],
    });
    expect((await recordCandidate(db, candidate)).outcome).toBe("recorded");

    const stored = await loadCandidates(db);

    expect(stored[0]).toEqual({ ...candidate, latestEvaluation: null });
  });
});
