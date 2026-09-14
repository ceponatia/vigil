import { SYNTHETIC_INSTRUMENT_ID } from "@vigil/market";

/**
 * quote-fixtures.ts — package-local test support (not exported from this
 * package's public `index.ts`; import only from this package's own
 * `*.test.ts` files, per
 * .agents/skills/vigil-testing/references/existing-helpers.md).
 *
 * A single well-formed raw quote-snapshot literal shared by
 * `candidate.test.ts` and `no-chasing.test.ts` — both need "a valid quote
 * to derive a candidate from, then mutate the ask price of". `@vigil/market`
 * does not export its own equivalent fixture from its public surface, so
 * this package keeps its own rather than reaching into that package's
 * `src/test-support/`.
 */
export const validRawQuote = {
  instrumentId: SYNTHETIC_INSTRUMENT_ID,
  bidPrice: "250.00",
  askPrice: "250.10",
  bidQuantity: "50.0000",
  askQuantity: "50.0000",
  timestamps: {
    quoteAcquiredAt: "2024-01-01T00:00:00.000Z",
    ingestedAt: "2024-01-01T00:00:00.250Z",
  },
};
