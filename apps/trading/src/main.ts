import { hostname } from "node:os";

import { createDbClient } from "@vigil/db";
import pino from "pino";

import { loadTradingConfig } from "./config";
import { startHeartbeatLoop } from "./health/heartbeat";

/**
 * main.ts — BOOT-07's runtime entry point: config, a database connection,
 * structured logging, and the heartbeat loop the dashboard reads
 * (`apps/trading/README.md` "Planned module directories", `health/`;
 * `apps/control/src/lib/health.ts`). Market, strategy, allocator,
 * execution, outbox, and reconcile are BOOT-06 and not built here.
 */

const HEARTBEAT_INTERVAL_MS = 5_000;

function instanceId(): string {
  // `pid` alone collides across containers — every container's first
  // process is PID 1 — so the hostname (container id or host name) goes
  // first to keep two instances distinguishable in the dashboard.
  return `${hostname()}-pid-${process.pid.toString()}`;
}

async function main(): Promise<void> {
  const configResult = loadTradingConfig();
  const logger = pino({ level: configResult.outcome === "ok" ? configResult.config.logLevel : "info" });

  if (configResult.outcome === "refused") {
    // Never logs DATABASE_URL or any other secret-shaped value — only the
    // refusal code and a diagnostic detail (docs/resilience.md §10 "Logging").
    logger.error({ code: configResult.code, detail: configResult.detail }, "refusing to start");
    process.exitCode = 1;
    return;
  }

  const { config } = configResult;
  const client = createDbClient({ connectionString: config.databaseUrl, applicationName: "vigil-trading" });

  logger.info({ mode: config.mode }, "vigil-trading starting");

  const loop = startHeartbeatLoop({
    db: client.db,
    logger,
    intervalMs: HEARTBEAT_INTERVAL_MS,
    mode: config.mode,
    instanceId: instanceId(),
    now: () => new Date().toISOString(),
    // Stays null until BOOT-06 wires the market engine.
    lastQuoteAcquiredAt: () => null,
  });

  let shuttingDown = false;
  // `string`, not the global `NodeJS` namespace's `Signals` type —
  // `no-undef` (`js.configs.recommended`) does not know that namespace
  // exists. A `Signals` literal union is assignable to `string`, and a
  // narrower type here would fail `strictFunctionTypes` against
  // `process.on`'s own `SignalsListener` parameter type.
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "vigil-trading shutting down");
    loop.stop();
    client
      .close()
      .then(() => {
        logger.info({}, "vigil-trading stopped");
      })
      .catch((error: unknown) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "error while closing the database pool",
        );
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  // A programmer error escaping every diagnostic path above — the one place
  // in this file an exception is appropriate (docs/resilience.md §4).
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
