import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Pool, PoolConfig } from "pg";

import * as intentsSchema from "./schema/intents";
import * as journalSchema from "./schema/journal";

/**
 * The Postgres client factory. It takes the connection string as an argument
 * and never reads `process.env` itself: a library that reaches for the
 * environment can connect to a different database than its caller believes
 * it is talking to, which for a financial record store is the worst possible
 * class of surprise. The caller — an app entry point, a migration script, a
 * test — is where `DATABASE_URL` is read.
 */

export const schema = { ...journalSchema, ...intentsSchema };

export type VigilSchema = typeof schema;

export type VigilDatabase = NodePgDatabase<VigilSchema>;

export type DbClientOptions = {
  readonly connectionString: string;
  readonly maxConnections?: number;
  /** Shows up in `pg_stat_activity`; helps attribute a lock to a process. */
  readonly applicationName?: string;
};

export type DbClient = {
  readonly db: VigilDatabase;
  readonly pool: Pool;
  readonly close: () => Promise<void>;
};

export function createDbClient(options: DbClientOptions): DbClient {
  const connectionString = options.connectionString.trim();
  if (connectionString === "") {
    // A configuration error, not schema-legal input: an empty connection
    // string can only fail, and failing here names the reason.
    throw new Error("createDbClient requires a non-empty connection string (DATABASE_URL)");
  }

  const config: PoolConfig = {
    connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "vigil",
  };
  const pool = new pg.Pool(config);

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
