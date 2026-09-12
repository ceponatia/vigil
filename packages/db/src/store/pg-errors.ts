/**
 * Turning a driver error into a diagnostic.
 *
 * A check or unique constraint firing is not a crash — it is the database
 * enforcing an invariant the application was about to break, and the caller
 * deserves a reason code rather than a stack trace
 * (`docs/resilience.md` §4). Anything that is not a recognised constraint
 * violation is re-thrown: an unreachable database or a syntax error is a
 * real failure and must not be reported as a routine refusal.
 *
 * **The error that arrives is not the error Postgres raised.** drizzle-orm
 * wraps every failed query in its own error and hangs the driver's error off
 * `cause`, sometimes more than one level deep ("Caused by: Caused by: …" in
 * a stack). Reading `code` off the object that was thrown finds nothing, so
 * every refusal would look like an unrecognised failure and be re-thrown —
 * which is exactly what CI run 34721798208 showed for every constraint in
 * this schema. These helpers walk the `cause` chain instead.
 */

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_CHECK_VIOLATION = "23514";
/**
 * `numeric field overflow`: an amount with more digits than a
 * `numeric(78, 0)` base-unit column holds. `@vigil/ledger` refuses such an
 * amount before it is ever built into an entry, so reaching this code means
 * a caller bypassed that check — it is still a diagnostic, never a crash.
 */
export const PG_NUMERIC_VALUE_OUT_OF_RANGE = "22003";
/**
 * A foreign key with nothing to point at. Two of them carry invariants
 * rather than mere referential tidiness: a reversal naming an entry that is
 * not in durable history, and base units at a scale the asset is not
 * registered with.
 */
export const PG_FOREIGN_KEY_VIOLATION = "23503";
/** Raised by the append-only trigger on the journal tables. */
export const PG_RAISE_EXCEPTION = "P0001";

/** Deep enough for drizzle's wrapping; bounded so a cyclic cause cannot spin. */
const MAX_CAUSE_DEPTH = 8;

type PostgresErrorLike = {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
};

/**
 * The first error in the `cause` chain that carries a SQLSTATE. Returning
 * the whole shape rather than one field keeps `code` and `constraint` read
 * from the *same* error: a wrapper that carried one and the driver error the
 * other would otherwise produce a confident, wrong mapping.
 */
function postgresError(error: unknown): PostgresErrorLike | null {
  let candidate: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) {
      return null;
    }
    // `object` has no properties in common with an all-optional type, so
    // this is an assertion rather than an assignment.
    const shape = candidate as PostgresErrorLike;
    if (typeof shape.code === "string") {
      return shape;
    }
    candidate = shape.cause;
  }

  return null;
}

export function postgresErrorCode(error: unknown): string | null {
  const shape = postgresError(error);
  return shape !== null && typeof shape.code === "string" ? shape.code : null;
}

export function postgresConstraintName(error: unknown): string | null {
  const shape = postgresError(error);
  return shape !== null && typeof shape.constraint === "string" ? shape.constraint : null;
}
