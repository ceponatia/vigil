import { hostname } from "node:os";

import { createDbClient } from "@vigil/db";
import pino from "pino";

import { loadTradingConfig } from "./config";
import { startReservationExpirySweep } from "./execution/expiry";
import { startHeartbeatLoop } from "./health/heartbeat";

/**
 * main.ts — BOOT-07's runtime entry point: config, a database connection,
 * structured logging, the heartbeat loop the dashboard reads
 * (`apps/trading/README.md` "Planned module directories", `health/`;
 * `apps/control/src/lib/health.ts`), and the reservation expiry sweep. The
 * market, strategy, allocator, outbox, and reconcile loops are not built
 * here.
 *
 * The expiry sweep is started here rather than by whatever drives execution
 * because it is not driven by execution at all: the hold it exists to end
 * belongs to an intent that stopped producing events, so a sweep reachable
 * only from the execution path would never reach it
 * (`execution/expiry.ts`).
 */

const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * A minute. The window being enforced is the intent's own `valid_until`,
 * measured in minutes at least, so a sweep an order of magnitude finer than
 * that buys nothing and costs a query per tick.
 */
const RESERVATION_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

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

  const expirySweep = startReservationExpirySweep({
    db: client.db,
    logger,
    intervalMs: RESERVATION_EXPIRY_SWEEP_INTERVAL_MS,
    now: () => new Date().toISOString(),
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
    expirySweep.stop();
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
