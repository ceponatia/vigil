import { createDbClient } from "@vigil/db";
import type { DbClient, VigilDatabase } from "@vigil/db";

/**
 * db.ts — one `createDbClient` per process (module-level singleton). A
 * fresh connection pool per request would exhaust Postgres connections
 * under any real load, and this dashboard has exactly one long-lived
 * server process to hold one for.
 *
 * The connection string is a plain argument, never read from
 * `process.env` here — that boundary belongs to `./env.ts` alone
 * (docs/architecture.md "Configuration and secrets").
 */

let cachedClient: DbClient | null = null;

export function getDbClient(databaseUrl: string): DbClient {
  cachedClient ??= createDbClient({ connectionString: databaseUrl, applicationName: "vigil-control" });
  return cachedClient;
}

export function getDb(databaseUrl: string): VigilDatabase {
  return getDbClient(databaseUrl).db;
}
