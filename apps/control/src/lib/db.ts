import { createDbClient } from "@vigil/db";
import type { DbClient, VigilDatabase } from "@vigil/db";

/**
 * db.ts — one `createDbClient` per distinct connection string, cached for
 * the life of the process. A fresh connection pool per request would
 * exhaust Postgres connections under any real load; keying the cache by
 * `databaseUrl` (rather than a single unkeyed singleton) means a config
 * change between calls — a test, or a future reload — opens its own pool
 * instead of one caller silently reusing another's.
 *
 * The connection string is a plain argument, never read from
 * `process.env` here — that boundary belongs to `./env.ts` alone
 * (docs/architecture.md "Configuration and secrets").
 */

const cachedClients = new Map<string, DbClient>();

export function getDbClient(databaseUrl: string): DbClient {
  const existing = cachedClients.get(databaseUrl);
  if (existing !== undefined) {
    return existing;
  }
  const client = createDbClient({ connectionString: databaseUrl, applicationName: "vigil-control" });
  cachedClients.set(databaseUrl, client);
  return client;
}

export function getDb(databaseUrl: string): VigilDatabase {
  return getDbClient(databaseUrl).db;
}
