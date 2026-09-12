import { defineConfig } from "drizzle-kit";

// DATABASE_URL is loaded by the CALLER's environment (dotenv inside the
// scripts that invoke drizzle-kit, or the shell's own exported env) — this
// file never guesses a connection string or falls back to a hardcoded
// localhost default. Its absence surfaces as an obvious empty-string
// connection failure rather than a silent, wrong-database connect.
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
