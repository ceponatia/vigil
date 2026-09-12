import { configDefaults, defineConfig } from "vitest/config";

/**
 * The ONLY Vitest config in this workspace.
 *
 * No workspace package declares a `test` script, and none should: a
 * package's `package.json` "typecheck" script is the only one it owns.
 * Suites live next to the source they test (`apps/**\/src/**\/*.test.ts`,
 * `packages/**\/src/**\/*.test.ts`) and cross-package suites live under
 * `tests/`, but ALL of them are discovered and run from here, split into two
 * projects by cost rather than by package:
 *
 *   - `unit`        — no external services; safe to run anywhere, anytime.
 *   - `integration` — needs the Postgres container from docker-compose.yml
 *                     (`pnpm db:up` first); named `*.int.test.ts`.
 *
 * Splitting by cost instead of by package means adding a package never
 * means adding a project here or a name to a root script — the `include`
 * globs already reach it. It also means `packages/db`'s integration suite
 * and `apps/trading`'s integration suite run under the identical
 * `--no-file-parallelism` policy without either package having to know
 * about the other's existence.
 */
export default defineConfig({
  test: {
    // Cap worker fan-out. The default forks pool spawns roughly one process
    // per core, each holding a full module graph — a memory spike this
    // workspace does not need since most suites here are small, pure-function
    // tests. 3 keeps runs parallel without the spike.
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "apps/**/src/**/*.test.ts",
            "packages/**/src/**/*.test.ts",
            "tests/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
          // No setupFiles yet. A synthetic-market / fake-provider harness
          // attaches here once a suite needs one (packages/market's
          // synthetic fixtures, apps/research's fake LLM provider) — not
          // before, so an empty setup file cannot silently hide a suite
          // that forgot to opt in.
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["**/*.int.test.ts"],
          exclude: [...configDefaults.exclude],
        },
      },
    ],
  },
});
