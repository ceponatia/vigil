import { generateCandidate } from "@vigil/strategies";
import type { GenerateCandidateResult, StrategyConfig } from "@vigil/strategies";
import type { IsoUtcTimestamp } from "@vigil/contracts";

import type { Instrument } from "../position-plan";
import { instant, money, policyConfig } from "./execution-fixtures";
import { SYNTHETIC_MARKET_EXPECTED_QUOTES } from "../../../../../tests/fixtures/synthetic-market";
import type { SyntheticMarketFixtureQuote } from "../../../../../tests/fixtures/synthetic-market";

/**
 * replay-scenario.ts — which two recorded quotes the BOOT-08 vertical replay
 * runs on, and the strategy parameters that turn the first of them into a
 * candidate. Nothing else.
 *
 * Two suites depend on these values agreeing:
 * `vertical-replay.int.test.ts` drives the whole path with them, and
 * `vertical-replay-premise.test.ts` is the guard that the recording still
 * describes that scenario at all. Stated separately in each file — as they
 * were — the guard could go on proving the fixture matches values the replay
 * no longer uses, which is exactly the silent substitution it exists to
 * catch. A comment cannot enforce that; one importable source can.
 *
 * ## Deliberately not a harness
 *
 * `execution-fixtures.ts` owns the venue, policy, portfolio, funding and
 * database wiring every execution suite shares, and this module builds on it
 * rather than competing with it. What lives here is only what is specific to
 * this one scenario: two indexes, the config, the injected instants, and the
 * two derived steps both suites must perform identically. Anything reusable
 * beyond the replay belongs next door.
 *
 * It is also the only file in `apps/trading` that reaches into
 * `tests/fixtures/`, so the cross-directory import is in one place.
 *
 * Pure: no database, no adapter, no `expect`, no clock read.
 */

/** Index 5 of the recording: a local high, where the candidate is formed. */
export const FORMATION_QUOTE_INDEX = 5;

/** Index 8: the later pullback the candidate's entry zone has to contain. */
export const ENTRY_QUOTE_INDEX = 8;

export type { SyntheticMarketFixtureQuote };

function recordedQuoteAt(index: number): SyntheticMarketFixtureQuote {
  const quote = SYNTHETIC_MARKET_EXPECTED_QUOTES[index];
  if (quote === undefined) {
    throw new Error(
      `the recorded BOOT-03 fixture has no quote at index ${String(index)}; the vertical replay's scenario must be re-derived`,
    );
  }
  return quote;
}

export const FORMATION_QUOTE = recordedQuoteAt(FORMATION_QUOTE_INDEX);
export const ENTRY_QUOTE = recordedQuoteAt(ENTRY_QUOTE_INDEX);

/**
 * One second after each quote was acquired — inside every freshness window
 * the replay evaluates against, and injected rather than read, so the same
 * scenario produces the same records on every run.
 */
export const FORMATION_NOW: IsoUtcTimestamp = instant("2024-01-01T00:05:01.000Z");
export const ENTRY_NOW: IsoUtcTimestamp = instant("2024-01-01T00:08:01.000Z");

/**
 * The strategy's parameters for this replay.
 *
 * `DEFAULT_STRATEGY_CONFIG`'s 2.00 pullback and 3.00 zone width cannot reach
 * an entry on this recording at all: the recorded asks span 249.61 to 250.96,
 * so a zone set 2.00 below any of them is never revisited within the
 * recording. These offsets are sized to the fixture's actual movement
 * instead — a deploy-time value, exactly as `StrategyConfig` describes.
 *
 * `pullback` (0.50) exceeds `allowedExtension` (0.25) on purpose, and the
 * replay's counter-case rests on it: the ask that forms a candidate is
 * therefore always beyond the extension, and so is never an entry of its own.
 */
export const REPLAY_STRATEGY_CONFIG: StrategyConfig = {
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

/**
 * A recorded quote re-keyed onto one case's own synthetic instrument.
 *
 * Every price, quantity and instant is the fixture's verbatim — including the
 * 250ms ingestion lag, which `evaluateQuoteFreshness` checks against both
 * `quoteAcquiredAt` and `now`. Only the instrument id differs, because the
 * shared integration database gives each case its own asset pair.
 *
 * Returns `unknown`: this is the untrusted shape every boundary that takes it
 * parses for itself.
 */
export function replayQuote(instrument: Instrument, recorded: SyntheticMarketFixtureQuote): unknown {
  return {
    instrumentId: `${instrument.baseAssetId}/${instrument.quoteAssetId}`,
    bidPrice: recorded.bidPrice,
    askPrice: recorded.askPrice,
    bidQuantity: recorded.bidQuantity,
    askQuantity: recorded.askQuantity,
    timestamps: {
      quoteAcquiredAt: recorded.timestamps.quoteAcquiredAt,
      ingestedAt: recorded.timestamps.ingestedAt,
    },
  };
}

/**
 * Forms the replay's candidate from a recorded quote.
 *
 * Shared rather than written twice because the candidate is the one derived
 * value the premise guard and the replay must agree on exactly: the guard
 * checks the entry zone this produces, and the replay authorizes against it.
 * The result is handed back unnarrowed — a suite asserting that the recording
 * still yields a candidate at all wants the outcome, and one that only needs
 * the candidate wants to fail loudly.
 */
export function formReplayCandidate(
  instrument: Instrument,
  recorded: SyntheticMarketFixtureQuote,
  now: IsoUtcTimestamp,
): GenerateCandidateResult {
  return generateCandidate({
    quote: replayQuote(instrument, recorded),
    now,
    maxQuoteAgeMs: policyConfig().maxQuoteAgeMs,
    config: REPLAY_STRATEGY_CONFIG,
  });
}
