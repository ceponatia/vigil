import { defineConfig } from "drizzle-kit";

// DATABASE_URL is loaded by the CALLER's environment (dotenv inside the
// scripts that invoke drizzle-kit, or the shell's own exported env) — this
// file never guesses a connection string or falls back to a hardcoded
// localhost default. Its absence surfaces as an obvious empty-string
// connection failure rather than a silent, wrong-database connect.
export default defineConfig({
  dialect: "postgresql",
  // Every schema module, listed rather than globbed.
  //
  // A `packages/db/src/schema/*.ts` glob loads whatever is in that directory
  // as if it were a schema module, and a `*.test.ts` beside its module is the
  // ordinary thing to write. `vitest` publishes a `require` condition whose
  // file — `node_modules/vitest/index.cjs` — is a bare `throw`, so
  // drizzle-kit's CommonJS bin hits it the moment it transforms such a file
  // and `db:generate` dies before reading any schema at all. The error names
  // vitest and CommonJS and points nowhere near this line, which is why the
  // prose warnings in `schema-invariants.int.test.ts` and
  // `schema-intent-states.test.ts` did not stop it happening.
  //
  // A list fails the other way. Add a record family and forget to register
  // it here, and the next generation emits `DROP TABLE "<it>" CASCADE` —
  // which `drizzle/README.md`'s review-the-generated-SQL step is exactly
  // where it gets caught, loud and about the thing that actually changed.
  // That is the better failure of the two, and it is the reason this is a
  // list and not a negated glob whose flavour drizzle-kit does not document.
  schema: [
    "./packages/db/src/schema/decisions.ts",
    "./packages/db/src/schema/intents.ts",
    "./packages/db/src/schema/journal.ts",
    "./packages/db/src/schema/ops.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
