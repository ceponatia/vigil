import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal, generateCandidate } from "@vigil/strategies";
import type { StrategyConfig } from "@vigil/strategies";

import { instant, money, policyConfig, syntheticInstrument } from "./test-support/execution-fixtures";
import { SYNTHETIC_MARKET_EXPECTED_QUOTES } from "../../../../tests/fixtures/synthetic-market";

/**
 * vertical-replay-premise.test.ts — the guard that keeps
 * `vertical-replay.int.test.ts` honest about which scenario it is running.
 *
 * That replay picks two quotes out of the recorded BOOT-03 fixture and
 * derives every number in its assertions from them: a local high at index 5
 * forms a candidate whose entry zone a later pullback at index 8 falls
 * inside, and the size it trades is index 8's own top-of-book quantity. If
 * the fixture is re-recorded, or `generateCandidate`'s formation rule
 * changes, those two quotes stop describing that scenario and the replay
 * quietly starts testing something else.
 *
 * ## Why this is a unit suite and not part of the replay
 *
 * It is pure `@vigil/strategies` arithmetic, so it belongs at the lowest
 * layer that owns it — but the reason it had to move is about CI selection,
 * not tidiness. The `integration` job is selected for `packages/db/*`,
 * `packages/ledger/*`, `apps/trading/*`, `drizzle/*`, the compose and build
 * config, `*.int.test.ts`, `tests/replay/*` and `tests/fault-injection/*`.
 * It is NOT selected for `tests/fixtures/*` or `packages/strategies/*` —
 * which are exactly the two paths a change that invalidates this premise
 * would touch. Living inside the `*.int.test.ts`, this guard would never
 * have run on the change it exists to catch. `unit tests` runs on any
 * non-docs change, so here it does.
 *
 * ## Keep these two files in step
 *
 * `REPLAY_STRATEGY_CONFIG` and the two quote indexes below are stated in
 * this file and in `vertical-replay.int.test.ts`. They are deliberately not
 * shared through `test-support/execution-fixtures.ts`, which four other
 * suites consume and which has no business knowing about this scenario.
 * Change them in both files or the guard stops describing the replay.
 *
 * Pure: no database, no adapter, no network, no clock read — `now` is
 * injected, as `@vigil/strategies` requires.
 */

/** Index 5: a local high. The candidate is formed here. */
const FORMATION_INDEX = 5;
/** Index 8: the later pullback the candidate's zone has to contain. */
const ENTRY_INDEX = 8;

const FORMATION_NOW = instant("2024-01-01T00:05:01.000Z");

/**
 * The replay's strategy parameters, restated. `DEFAULT_STRATEGY_CONFIG`'s
 * 2.00 pullback cannot reach an entry anywhere in this recording — the
 * recorded asks span 249.61 to 250.96 — so the replay sizes its offsets to
 * the fixture's actual movement. `pullback` (0.50) exceeds
 * `allowedExtension` (0.25) on purpose: that is what makes the ask which
 * forms a candidate lie beyond the extension, and so never be an entry of
 * its own.
 */
const REPLAY_STRATEGY_CONFIG: StrategyConfig = {
  strategyId: "bounded-pullback-v1",
  strategyVersion: "1.0.0",
  actionDetail: "SMALL_STARTER",
  horizon: "swing",
  pullback: money("0.50"),
  zoneWidth: money("1.50"),
  invalidationOffset: money("2.00"),
  allowedExtension: money("0.25"),
  trancheCount: 3,
  totalQuantity: money("3.0000"),
  expiryMs: 24 * 60 * 60 * 1000,
};

function recordedQuoteAt(index: number) {
  const quote = SYNTHETIC_MARKET_EXPECTED_QUOTES[index];
  if (quote === undefined) {
    throw new Error(
      `the recorded BOOT-03 fixture has no quote at index ${String(index)}; the vertical replay's scenario must be re-derived`,
    );
  }
  return quote;
}

describe("the BOOT-03 recording the vertical PAPER replay is built on", () => {
  it("still holds the prices and instants the replay derives every one of its numbers from", () => {
    const formation = recordedQuoteAt(FORMATION_INDEX);
    const entry = recordedQuoteAt(ENTRY_INDEX);

    // `tests/replay/synthetic-market.test.ts` owns the claim that these are
    // what the synthetic feed produces. Pinned again here because the
    // replay's arithmetic — its execution prices, its net edge, its traded
    // size — was derived from these exact values by hand, and a re-recording
    // has to re-derive them rather than silently shift them.
    expect(formation.bidPrice).toBe("250.86");
    expect(formation.askPrice).toBe("250.96");
    expect(formation.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:05:00.000Z");
    expect(entry.bidPrice).toBe("249.51");
    expect(entry.askPrice).toBe("249.61");
    // The replay's traded quantity IS this number: capital and caps are set
    // wide enough that executable liquidity is the binding sizing bound.
    expect(entry.askQuantity).toBe("48.6798");
    expect(entry.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:08:00.000Z");
  });

  it("still forms an entry zone that contains the later pullback and excludes the ask that formed it", () => {
    const formation = recordedQuoteAt(FORMATION_INDEX);
    const entry = recordedQuoteAt(ENTRY_INDEX);
    const instrument = syntheticInstrument("vertpremise");

    const generated = generateCandidate({
      quote: {
        instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
        bidPrice: formation.bidPrice,
        askPrice: formation.askPrice,
        bidQuantity: formation.bidQuantity,
        askQuantity: formation.askQuantity,
        timestamps: {
          quoteAcquiredAt: formation.timestamps.quoteAcquiredAt,
          ingestedAt: formation.timestamps.ingestedAt,
        },
      },
      now: FORMATION_NOW,
      maxQuoteAgeMs: policyConfig().maxQuoteAgeMs,
      config: REPLAY_STRATEGY_CONFIG,
    });

    // A recording that went stale, lost its shape, or fell below the rule's
    // range would land on `no-candidate` or `no-signal`, and the replay's
    // first step would have nothing to carry.
    expect(generated.outcome).toBe("candidate");
    if (generated.outcome !== "candidate") {
      return;
    }
    const candidate = generated.candidate;

    // The zone the rule sets from the formation ask: 250.96 - 0.50 = 250.46
    // down to 250.46 - 1.50 = 248.96, invalidated 2.00 below that floor.
    expect(candidate.entryZone.max).toBe("250.46");
    expect(candidate.entryZone.min).toBe("248.96");
    expect(candidate.invalidationPrice).toBe("246.96");

    // The premise the replay's eligible case rests on.
    const entryAsk = money(entry.askPrice);
    expect(compareDecimal(entryAsk, candidate.entryZone.min)).toBeGreaterThanOrEqual(0);
    expect(compareDecimal(entryAsk, candidate.entryZone.max)).toBeLessThanOrEqual(0);

    // And the premise the replay's counter-case rests on: the ask that
    // formed this candidate is past the allowed extension, so it is a
    // MISSED entry and never a late BUY at the higher price.
    const extendedMax = addDecimal(candidate.entryZone.max, candidate.allowedExtension);
    expect(extendedMax).toBe("250.71");
    expect(compareDecimal(money(formation.askPrice), extendedMax)).toBeGreaterThan(0);

    // The staged plan the replay persists and reads back out of
    // `candidate_tranches`. Quantities sum to the configured total; triggers
    // walk the zone from its top to its floor.
    expect(candidate.positionPlan.tranches.map((tranche) => tranche.quantity)).toEqual(["1", "1", "1"]);
    expect(candidate.positionPlan.tranches.map((tranche) => tranche.triggerPrice)).toEqual([
      "250.46",
      "249.71",
      "248.96",
    ]);
  });
});
