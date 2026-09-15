import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal } from "@vigil/strategies";

import { money, syntheticInstrument } from "./test-support/execution-fixtures";
import {
  ENTRY_QUOTE,
  FORMATION_NOW,
  FORMATION_QUOTE,
  formReplayCandidate,
} from "./test-support/replay-scenario";

/**
 * vertical-replay-premise.test.ts — the guard that keeps
 * `vertical-replay.int.test.ts` honest about which scenario it is running.
 *
 * That replay picks two quotes out of the recorded BOOT-03 fixture and
 * derives every number in its assertions from them: a local high forms a
 * candidate whose entry zone a later pullback falls inside, and the size it
 * trades is that later quote's own top-of-book quantity. If the fixture is
 * re-recorded, or `generateCandidate`'s formation rule changes, those two
 * quotes stop describing that scenario and the replay quietly starts testing
 * something else.
 *
 * Both files read the quotes, the injected instants and the strategy config
 * from `test-support/replay-scenario.ts`, so this guard cannot end up
 * checking values the replay no longer uses — which is the one way a premise
 * guard fails silently rather than loudly.
 *
 * ## Why this is a unit suite and not part of the replay
 *
 * It is pure `@vigil/strategies` arithmetic, so it belongs at the lowest
 * layer that owns it — but the reason it lives outside the replay is about CI
 * selection, not tidiness. The `integration` job is selected for
 * `packages/db/*`, `packages/ledger/*`, `apps/trading/*`, `drizzle/*`, the
 * compose and build config, `*.int.test.ts`, `tests/replay/*` and
 * `tests/fault-injection/*`. It is NOT selected for `tests/fixtures/*` or
 * `packages/strategies/*` — which are exactly the two paths a change that
 * invalidates this premise would touch. Inside the `*.int.test.ts`, whose
 * module opens a database pool at load, this guard would never have run on
 * the change it exists to catch. `unit tests` runs on any non-docs change,
 * so here it does.
 *
 * Pure: no database, no adapter, no network, no clock read — `now` is
 * injected, as `@vigil/strategies` requires.
 */

describe("the BOOT-03 recording the vertical PAPER replay is built on", () => {
  it("still holds the prices and instants the replay derives every one of its numbers from", () => {
    // `tests/replay/synthetic-market.test.ts` owns the claim that these are
    // what the synthetic feed produces. Pinned again here because the
    // replay's arithmetic — its execution prices, its net edge, its traded
    // size — was derived from these exact values by hand, and a re-recording
    // has to re-derive them rather than silently shift them.
    expect(FORMATION_QUOTE.bidPrice).toBe("250.86");
    expect(FORMATION_QUOTE.askPrice).toBe("250.96");
    expect(FORMATION_QUOTE.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:05:00.000Z");
    expect(ENTRY_QUOTE.bidPrice).toBe("249.51");
    expect(ENTRY_QUOTE.askPrice).toBe("249.61");
    // The replay's traded quantity IS this number: capital and caps are set
    // wide enough that executable liquidity is the binding sizing bound.
    expect(ENTRY_QUOTE.askQuantity).toBe("48.6798");
    expect(ENTRY_QUOTE.timestamps.quoteAcquiredAt).toBe("2024-01-01T00:08:00.000Z");
  });

  it("still forms an entry zone that contains the later pullback and excludes the ask that formed it", () => {
    const instrument = syntheticInstrument("vertpremise");
    const generated = formReplayCandidate(instrument, FORMATION_QUOTE, FORMATION_NOW);

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
    const entryAsk = money(ENTRY_QUOTE.askPrice);
    expect(compareDecimal(entryAsk, candidate.entryZone.min)).toBeGreaterThanOrEqual(0);
    expect(compareDecimal(entryAsk, candidate.entryZone.max)).toBeLessThanOrEqual(0);

    // And the premise the replay's counter-case rests on: the ask that formed
    // this candidate is past the allowed extension, so it is a MISSED entry
    // and never a late BUY at the higher price.
    const extendedMax = addDecimal(candidate.entryZone.max, candidate.allowedExtension);
    expect(extendedMax).toBe("250.71");
    expect(compareDecimal(money(FORMATION_QUOTE.askPrice), extendedMax)).toBeGreaterThan(0);

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
