/**
 * Turning a driver error into a diagnostic.
 *
 * A check or unique constraint firing is not a crash — it is the database
 * enforcing an invariant the application was about to break, and the caller
 * deserves a reason code rather than a stack trace
 * (`docs/resilience.md` §4). Anything that is not a recognised constraint
 * violation is re-thrown: an unreachable database or a syntax error is a
 * real failure and must not be reported as a routine refusal.
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
/** Raised by the append-only trigger on the journal tables. */
export const PG_RAISE_EXCEPTION = "P0001";

type PostgresErrorLike = {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
};

function asPostgresError(error: unknown): PostgresErrorLike | null {
  return typeof error === "object" && error !== null ? (error as PostgresErrorLike) : null;
}

function stringField(error: unknown, read: (shape: PostgresErrorLike) => unknown): string | null {
  const shape = asPostgresError(error);
  if (shape === null) {
    return null;
  }
  const value = read(shape);
  return typeof value === "string" ? value : null;
}

export function postgresErrorCode(error: unknown): string | null {
  return stringField(error, (shape) => shape.code);
}

export function postgresConstraintName(error: unknown): string | null {
  return stringField(error, (shape) => shape.constraint);
}
