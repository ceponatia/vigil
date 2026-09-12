import { isoUtcTimestampSchema } from "@vigil/contracts";
import type { IsoUtcTimestamp } from "@vigil/contracts";

import { canonicalInstrumentId } from "./instrument-identity";
import type { InstrumentIdentity, InstrumentId } from "./instrument-identity";
import { createMulberry32, randomBigIntInRange, unitsToDecimalString } from "./prng";
import { quoteSnapshotSchema } from "./quote-snapshot";
import type { QuoteSnapshot } from "./quote-snapshot";

/**
 * synthetic-feed.ts — a seeded, deterministic synthetic quote generator
 * (this issue's settled scope: "a seeded, deterministic generator in
 * `packages/market` … whose prices and quantities are produced by integer
 * arithmetic and rendered as `DecimalString`"). One synthetic
 * instrument/route only — no second instrument.
 *
 * Determinism chain: `createMulberry32` (packages/market/src/prng.ts) is
 * the only source of randomness, seeded once per call from
 * `SyntheticFeedParams.seed`; every price and quantity is walked as a
 * `bigint` integer number of base units and rendered through
 * `unitsToDecimalString`, never through a JavaScript number or
 * `parseFloat`/`toFixed`; every timestamp is derived from the injected
 * `startTimestamp` plus a fixed per-tick offset via `Date.parse`/`new
 * Date(ms)` (both pure functions of their arguments — this module reads no
 * clock, per this issue's settled scope for `@vigil/contracts` and
 * `@vigil/market`). Calling `generateSyntheticQuotes` twice with the same
 * params therefore always produces two deeply-equal arrays — the property
 * `tests/replay/synthetic-market.test.ts` proves against a fixture
 * recorded under `tests/fixtures/`.
 */

const SYNTHETIC_INSTRUMENT: InstrumentIdentity = {
  baseAsset: { kind: "native", chainId: "1337", nativeDenomination: "VGLBASE", withdrawalNetwork: "SYNTHETIC_TESTNET" },
  quoteAsset: { kind: "native", chainId: "1337", nativeDenomination: "VGLQUOTE", withdrawalNetwork: "SYNTHETIC_TESTNET" },
};

/**
 * The single synthetic instrument this package generates quotes for.
 * `chainId: "1337"` and both denominations are obviously-synthetic labels
 * on a conventional local/test EVM chain id — never a production chain,
 * address, or holding (AGENTS.md; docs/README.md).
 */
export const SYNTHETIC_INSTRUMENT_ID: InstrumentId = canonicalInstrumentId(SYNTHETIC_INSTRUMENT);

const PRICE_SCALE = 2;
const QUANTITY_SCALE = 4;
const START_PRICE_UNITS = 25_000n; // "250.00"
const MAX_PRICE_DELTA_UNITS = 50n; // up to +/- "0.50" per tick
const SPREAD_UNITS = 10n; // ask = bid + "0.10"
const BASE_QUANTITY_UNITS = 500_000n; // "50.0000"
const MAX_QUANTITY_DELTA_UNITS = 50_000n; // up to +/- "5.0000" per tick
const TICK_INTERVAL_MS = 60_000; // one synthetic tick per simulated minute
const INGESTION_LAG_MS = 250; // ingestedAt is always slightly after quoteAcquiredAt

export type SyntheticFeedParams = {
  /**
   * Seeds the deterministic PRNG; the same seed always yields the same
   * sequence. Must be an integer — `createMulberry32` (prng.ts) truncates
   * a fractional seed via `seed | 0` with no diagnostic, so this function
   * checks first rather than silently generating from the truncated value.
   */
  readonly seed: number;
  /**
   * Number of quotes to generate. Must be a non-negative safe integer: an
   * infinite or NaN count would hang or corrupt the generation loop, and a
   * non-integer count would round unpredictably at the loop boundary.
   * Zero is valid and yields an empty sequence.
   */
  readonly count: number;
  /**
   * ISO-8601 UTC timestamp of the first quote's quote-acquisition time.
   * Branded `IsoUtcTimestamp` rather than a bare `string` so a caller must
   * have gone through `isoUtcTimestampSchema` at least once — this
   * generator is a test fixture, not a money path, so it trusts the brand
   * rather than re-validating it on every call.
   */
  readonly startTimestamp: IsoUtcTimestamp;
};

/**
 * Generates `params.count` synthetic quotes for the single synthetic
 * instrument, deterministically from `params.seed` and `params.startTimestamp`.
 * Pure: no IO, no clock read, no shared mutable module state across calls
 * (each call creates its own PRNG instance).
 */
export function generateSyntheticQuotes(params: SyntheticFeedParams): readonly QuoteSnapshot[] {
  // Both checks below guard against a programmer error at the call site
  // (this generator has no untrusted-input boundary of its own — its only
  // callers are this package's own tests and fixtures), consistent with
  // prng.ts's own `randomBigIntInRange`/`unitsToDecimalString` guards.
  if (!Number.isInteger(params.seed)) {
    throw new Error(`generateSyntheticQuotes: seed must be an integer, got ${String(params.seed)}`);
  }
  if (!Number.isSafeInteger(params.count) || params.count < 0) {
    throw new Error(`generateSyntheticQuotes: count must be a non-negative safe integer, got ${String(params.count)}`);
  }

  const startMs = Date.parse(params.startTimestamp);
  const nextUint32 = createMulberry32(params.seed);

  let priceUnits = START_PRICE_UNITS;
  let quantityUnits = BASE_QUANTITY_UNITS;
  const quotes: QuoteSnapshot[] = [];

  for (let tick = 0; tick < params.count; tick += 1) {
    priceUnits += randomBigIntInRange(nextUint32, -MAX_PRICE_DELTA_UNITS, MAX_PRICE_DELTA_UNITS);
    if (priceUnits < 1n) {
      priceUnits = 1n;
    }

    quantityUnits += randomBigIntInRange(nextUint32, -MAX_QUANTITY_DELTA_UNITS, MAX_QUANTITY_DELTA_UNITS);
    if (quantityUnits < 1n) {
      quantityUnits = 1n;
    }

    const quoteAcquiredAtMs = startMs + tick * TICK_INTERVAL_MS;
    const ingestedAtMs = quoteAcquiredAtMs + INGESTION_LAG_MS;

    const quote = quoteSnapshotSchema.parse({
      instrumentId: SYNTHETIC_INSTRUMENT_ID,
      bidPrice: unitsToDecimalString(priceUnits, PRICE_SCALE),
      askPrice: unitsToDecimalString(priceUnits + SPREAD_UNITS, PRICE_SCALE),
      bidQuantity: unitsToDecimalString(quantityUnits, QUANTITY_SCALE),
      askQuantity: unitsToDecimalString(quantityUnits, QUANTITY_SCALE),
      timestamps: {
        quoteAcquiredAt: isoUtcTimestampSchema.parse(new Date(quoteAcquiredAtMs).toISOString()),
        ingestedAt: isoUtcTimestampSchema.parse(new Date(ingestedAtMs).toISOString()),
      },
    });

    quotes.push(quote);
  }

  return quotes;
}
