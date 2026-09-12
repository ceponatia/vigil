import { SYNTHETIC_INSTRUMENT_ID } from "../synthetic-feed";

/**
 * quote-fixtures.ts — package-local test support (not exported from the
 * package's public `index.ts`; import only from this package's own
 * `*.test.ts` files, per .agents/skills/vigil-testing/references/
 * existing-helpers.md).
 *
 * A single well-formed raw quote-snapshot literal shared by
 * `quote-snapshot.test.ts` and `freshness.test.ts` — both suites need "a
 * valid quote to mutate one field of" and previously duplicated the same
 * literal.
 *
 * `instrumentId` is `SYNTHETIC_INSTRUMENT_ID` — the package's real
 * derived instrument id — rather than a hand-typed placeholder like
 * "instrument-a": `instrumentIdSchema` now validates the canonical
 * base/quote-asset-id shape `canonicalInstrumentId` produces, so an ad
 * hoc string no longer parses (see instrument-identity.test.ts and this
 * file's own use in quote-snapshot.test.ts / freshness.test.ts).
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
