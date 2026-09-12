import { isoUtcTimestampSchema } from "@vigil/contracts";

/**
 * synthetic-market.ts — the recorded BOOT-03 synthetic-market fixture.
 *
 * Records the exact input parameters and the exact expected quote sequence
 * for @vigil/market's synthetic feed
 * (packages/market/src/synthetic-feed.ts), seeded with
 * `SYNTHETIC_MARKET_FIXTURE_PARAMS.seed`. tests/replay/synthetic-market.test.ts
 * replays the generator with these parameters and asserts its output
 * matches `SYNTHETIC_MARKET_EXPECTED_QUOTES` exactly — proving the feed is
 * deterministic and reproducible across replays (docs/testing.md
 * "Replay"), not merely internally consistent with itself within one
 * process. If a future change to the generator's algorithm or constants
 * is intentional, this fixture is re-recorded deliberately; if it is not
 * intentional, the replay test's failure is exactly the regression this
 * fixture exists to catch.
 *
 * Entirely synthetic: no real chain, address, holding, or credential
 * appears anywhere in this fixture (AGENTS.md; docs/README.md). `1337` is
 * the conventional local/test EVM chain id; `VGLBASE`/`VGLQUOTE` and
 * `SYNTHETIC_TESTNET` are obviously-fake labels invented for this fixture,
 * never a real denomination or network.
 */

export const SYNTHETIC_MARKET_FIXTURE_PARAMS = {
  seed: 1337,
  count: 24,
  // Parsed once here at module load — generateSyntheticQuotes now takes
  // the branded IsoUtcTimestamp rather than a bare string.
  startTimestamp: isoUtcTimestampSchema.parse("2024-01-01T00:00:00.000Z"),
};

export type SyntheticMarketFixtureQuote = {
  readonly instrumentId: string;
  readonly bidPrice: string;
  readonly askPrice: string;
  readonly bidQuantity: string;
  readonly askQuantity: string;
  readonly timestamps: {
    readonly quoteAcquiredAt: string;
    readonly ingestedAt: string;
  };
};

/**
 * Recorded via a single offline invocation of
 * `generateSyntheticQuotes(SYNTHETIC_MARKET_FIXTURE_PARAMS)`
 * (packages/market/src/synthetic-feed.ts) and pinned here verbatim.
 */
export const SYNTHETIC_MARKET_EXPECTED_QUOTES: readonly SyntheticMarketFixtureQuote[] = [
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.33",
    askPrice: "250.43",
    bidQuantity: "53.9462",
    askQuantity: "53.9462",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:00:00.000Z",
      ingestedAt: "2024-01-01T00:00:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.26",
    askPrice: "250.36",
    bidQuantity: "54.1952",
    askQuantity: "54.1952",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:01:00.000Z",
      ingestedAt: "2024-01-01T00:01:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.18",
    askPrice: "250.28",
    bidQuantity: "55.5253",
    askQuantity: "55.5253",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:02:00.000Z",
      ingestedAt: "2024-01-01T00:02:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.49",
    askPrice: "250.59",
    bidQuantity: "54.2219",
    askQuantity: "54.2219",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:03:00.000Z",
      ingestedAt: "2024-01-01T00:03:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.46",
    askPrice: "250.56",
    bidQuantity: "51.4161",
    askQuantity: "51.4161",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:04:00.000Z",
      ingestedAt: "2024-01-01T00:04:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.86",
    askPrice: "250.96",
    bidQuantity: "47.9429",
    askQuantity: "47.9429",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:05:00.000Z",
      ingestedAt: "2024-01-01T00:05:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.38",
    askPrice: "250.48",
    bidQuantity: "50.8897",
    askQuantity: "50.8897",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:06:00.000Z",
      ingestedAt: "2024-01-01T00:06:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.90",
    askPrice: "250.00",
    bidQuantity: "49.5618",
    askQuantity: "49.5618",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:07:00.000Z",
      ingestedAt: "2024-01-01T00:07:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.51",
    askPrice: "249.61",
    bidQuantity: "48.6798",
    askQuantity: "48.6798",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:08:00.000Z",
      ingestedAt: "2024-01-01T00:08:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.55",
    askPrice: "249.65",
    bidQuantity: "44.3369",
    askQuantity: "44.3369",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:09:00.000Z",
      ingestedAt: "2024-01-01T00:09:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.62",
    askPrice: "249.72",
    bidQuantity: "40.2580",
    askQuantity: "40.2580",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:10:00.000Z",
      ingestedAt: "2024-01-01T00:10:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.84",
    askPrice: "249.94",
    bidQuantity: "41.5417",
    askQuantity: "41.5417",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:11:00.000Z",
      ingestedAt: "2024-01-01T00:11:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.14",
    askPrice: "250.24",
    bidQuantity: "44.0637",
    askQuantity: "44.0637",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:12:00.000Z",
      ingestedAt: "2024-01-01T00:12:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.91",
    askPrice: "250.01",
    bidQuantity: "46.6579",
    askQuantity: "46.6579",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:13:00.000Z",
      ingestedAt: "2024-01-01T00:13:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.39",
    askPrice: "250.49",
    bidQuantity: "46.9168",
    askQuantity: "46.9168",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:14:00.000Z",
      ingestedAt: "2024-01-01T00:14:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.39",
    askPrice: "250.49",
    bidQuantity: "48.2695",
    askQuantity: "48.2695",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:15:00.000Z",
      ingestedAt: "2024-01-01T00:15:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.14",
    askPrice: "250.24",
    bidQuantity: "46.1030",
    askQuantity: "46.1030",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:16:00.000Z",
      ingestedAt: "2024-01-01T00:16:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.67",
    askPrice: "249.77",
    bidQuantity: "43.6569",
    askQuantity: "43.6569",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:17:00.000Z",
      ingestedAt: "2024-01-01T00:17:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.15",
    askPrice: "250.25",
    bidQuantity: "46.6699",
    askQuantity: "46.6699",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:18:00.000Z",
      ingestedAt: "2024-01-01T00:18:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.20",
    askPrice: "250.30",
    bidQuantity: "45.9819",
    askQuantity: "45.9819",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:19:00.000Z",
      ingestedAt: "2024-01-01T00:19:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "249.92",
    askPrice: "250.02",
    bidQuantity: "48.5759",
    askQuantity: "48.5759",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:20:00.000Z",
      ingestedAt: "2024-01-01T00:20:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.15",
    askPrice: "250.25",
    bidQuantity: "51.8117",
    askQuantity: "51.8117",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:21:00.000Z",
      ingestedAt: "2024-01-01T00:21:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.57",
    askPrice: "250.67",
    bidQuantity: "54.7154",
    askQuantity: "54.7154",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:22:00.000Z",
      ingestedAt: "2024-01-01T00:22:00.250Z",
    },
  },
  {
    instrumentId: "1337|native|VGLBASE|SYNTHETIC_TESTNET/1337|native|VGLQUOTE|SYNTHETIC_TESTNET",
    bidPrice: "250.46",
    askPrice: "250.56",
    bidQuantity: "59.5199",
    askQuantity: "59.5199",
    timestamps: {
      quoteAcquiredAt: "2024-01-01T00:23:00.000Z",
      ingestedAt: "2024-01-01T00:23:00.250Z",
    },
  },
];
