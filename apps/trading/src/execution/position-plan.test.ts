import { describe, expect, it } from "vitest";

import type { StoredPositionPlan } from "@vigil/db";
import { checkEntryZone } from "@vigil/policy";

import { instrumentIdOf, planTermsFor } from "./position-plan";
import { money, storedPlan, syntheticInstrument } from "./test-support/execution-fixtures";

/**
 * The defects this file kills, all of them about a plan fetched **by id**
 * from a table whose rows this intent may not own.
 *
 * `approved_intents.position_plan_id` is `NOT NULL` text with no foreign key
 * behind it, so "the plan for this intent" is an application claim. A read
 * that trusted whatever came back under that id would let:
 *
 *  * **another instrument's band price this one.** Two instruments quoted in
 *    different numeraires produce an entry zone that is a perfectly valid
 *    decimal and wholly wrong, and the gate would report success on it.
 *  * **an unreadable price reach the arithmetic that decides whether to
 *    spend.** The column's own check refuses an exponent, a `NaN` and a
 *    negative alike, so a value this module rejects means the SQL and the
 *    application have drifted — the moment a cast past the branded type
 *    would be worst. `-300.00` is in the cases below for a reason:
 *    `decimalStringSchema` alone accepts it, so a check built on that schema
 *    and nothing else is a subset of the column's rule rather than the
 *    superset this package intends, and a negative bound would widen the
 *    approved band downward.
 *
 * No database is needed to hold either claim, so this is a unit test: the
 * cheapest layer that owns them.
 */

const INSTRUMENT = syntheticInstrument("planterms");
const OTHER = syntheticInstrument("planother");

describe("planTermsFor", () => {
  it("supplies exactly the stored band and exit target, in the branded decimal type the gate takes — catches a translation that widens, rounds, or transposes a term between the row and the check that spends money against it", () => {
    const result = planTermsFor(storedPlan("terms", INSTRUMENT), INSTRUMENT, "intent-terms");

    expect(result.outcome).toBe("terms");
    if (result.outcome !== "terms") {
      return;
    }
    // Whole-object equality: asserting min and the exit price separately
    // passes when max is read into the wrong field.
    expect(result.terms).toEqual({
      entryZone: { min: money("200.00"), max: money("300.00") },
      thesis: { expectedExitPriceQuote: money("260.00") },
    });
  });

  it("refuses a plan whose terms price another instrument, naming both — catches the id collision that would hand this dispatch a band quoted in a different numeraire, which is a valid decimal and a wrong one, and which every later gate would report success on", () => {
    const result = planTermsFor(storedPlan("cross", OTHER), INSTRUMENT, "intent-cross");

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") {
      return;
    }
    expect(result.refusal.reason).toEqual({ source: "execution", code: "POSITION_PLAN_UNUSABLE" });
    expect(result.refusal.detail).toContain(instrumentIdOf(OTHER));
    expect(result.refusal.detail).toContain(instrumentIdOf(INSTRUMENT));
  });

  // A plain loop rather than `it.each`: the cases pair a field name with a
  // partial record, and inferring that as one heterogeneous tuple is how a
  // case ends up typed loosely enough to pass an override this function
  // never sees.
  const unreadable: ReadonlyArray<readonly [string, Partial<StoredPositionPlan>]> = [
    ["entryZoneMin", { entryZoneMin: "2.0e2" }],
    ["entryZoneMax", { entryZoneMax: "-300.00" }],
    ["thesisExitPrice", { thesisExitPrice: "NaN" }],
  ];

  for (const [field, override] of unreadable) {
    it(`refuses a plan whose ${field} is not a non-negative decimal string, and names it — catches a value cast past the branded type into the arithmetic that decides whether to spend, which is precisely what a row the column's own check should have refused means`, () => {
      const result = planTermsFor(storedPlan("unreadable", INSTRUMENT, override), INSTRUMENT, "intent-unreadable");

      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") {
        return;
      }
      expect(result.refusal.reason).toEqual({ source: "execution", code: "POSITION_PLAN_UNUSABLE" });
      expect(result.refusal.detail).toContain(field);
    });
  }

  it("does not judge an inverted band itself, and leaves it to the check whose own parse refuses one — pins the boundary this module's header claims, and pins the reason rather than the verdict: an inverted band is an empty interval, so every price is outside it and `eligible === false` alone would still hold with `entryZoneSchema`'s refine deleted, which is the rule being relied on", () => {
    const inverted = storedPlan("inverted", INSTRUMENT, { entryZoneMin: "300.00", entryZoneMax: "200.00" });

    const result = planTermsFor(inverted, INSTRUMENT, "intent-inverted");
    expect(result.outcome).toBe("terms");
    if (result.outcome !== "terms") {
      return;
    }

    // …and the band is refused where the rule actually lives. `MALFORMED_INPUT`
    // comes from `entryZoneParamsSchema` failing to parse, which only the
    // min <= max refine can produce here; an out-of-band price under a
    // well-formed zone refuses as `OUTSIDE_ENTRY_ZONE` instead. Asserting the
    // former is what makes this case able to fail, and what makes the
    // decision not to restate the ordering rule as a SQL constraint over
    // decimal text load-bearing rather than merely stated.
    const refused = checkEntryZone({ executablePrice: money("250.36"), entryZone: result.terms.entryZone });
    expect(refused.eligible).toBe(false);
    if (refused.eligible) {
      return;
    }
    expect(refused.refusal.reason).toEqual({ source: "input", code: "MALFORMED_INPUT" });

    // The contrast that says the refusal above is about the inversion and not
    // about the price: the same price, against the same two bounds the right
    // way round, is eligible.
    expect(
      checkEntryZone({
        executablePrice: money("250.36"),
        entryZone: { min: money("200.00"), max: money("300.00") },
      }).eligible,
    ).toBe(true);
  });
});
