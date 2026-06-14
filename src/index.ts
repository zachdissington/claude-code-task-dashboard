/**
 * task-dashboard entry point.
 *
 *   1. Probe the Python interpreter (surfaces a misconfigured PYTHON_BIN early)
 *   2. Build the Fastify app, bind 127.0.0.1:PORT (localhost-only is the
 *      security boundary — the dashboard exposes the whole task store)
 *   3. Start the filesystem watcher
 *   4. Start a 6h background snapshot timer so the backlog-trend point for the
 *      day still lands when no browser tab is open
 *   5. Wire SIGINT/SIGTERM — SIGTERM fast-exits so PM2 restarts release the port
 */

import { config } from "./config.js";
import { getSnapshot } from "./data/snapshot.js";
import { armMorningPlanScheduler } from "./data/morning-plan.js";
import { drainOutbox } from "./data/outbox-drain.js";
import { probePython } from "./data/python-bridge.js";
import { logger } from "./logger.js";
import { buildDashboardApp } from "./server/dashboard-app.js";
import { cancelPendingCommit } from "./data/writeback-committer.js";
import { startWatcher } from "./watcher.js";

const TREND_TICK_MS = 6 * 60 * 60 * 1000; // 6h

async function main(): Promise<void> {
  await probePython();

  const app = await buildDashboardApp();

  try {
    await app.listen({ port: config.PORT, host: "127.0.0.1" });
    logger.info(
      { port: config.PORT, pid: process.pid },
      `task-dashboard listening on http://localhost:${config.PORT}`,
    );
  } catch (err) {
    logger.fatal({ err }, "failed to bind port");
    process.exit(1);
  }

  startWatcher();

  // Build one snapshot at boot (lands today's trend point) and every 6h after,
  // so the trend keeps accumulating with the tab closed.
  void getSnapshot().catch((err) => logger.warn({ err }, "boot-snapshot-failed"));
  const trendTimer = setInterval(() => {
    void getSnapshot().catch((err) => logger.warn({ err }, "trend-tick-failed"));
  }, TREND_TICK_MS);
  trendTimer.unref();

  // Weekday-07:00 morning auto-plan: propose a day's plan in the empty Today's
  // plan panel (accept/edit/reject). In-process timer, like the trend tick.
  armMorningPlanScheduler();

  // Offline durability (Part C): drain phone writes that landed in the outbox
  // Worker while the PC was off — on boot and every 30s. No-op until the Worker
  // is deployed + DASHBOARD_OUTBOX_* env is set.
  void drainOutbox().catch((err) => logger.warn({ err }, "outbox-boot-drain-failed"));
  const outboxTimer = setInterval(() => {
    void drainOutbox().catch((err) => logger.warn({ err }, "outbox-drain-failed"));
  }, 30_000);
  outboxTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown.start");
    cancelPendingCommit(); // drop any pending auto-commit; it re-fires on next activity

    // Fast-exit on SIGTERM (PM2 restart) so port 8790 is released immediately
    // and the next PM2 start does not hit EADDRINUSE. Give SSE clients 500ms.
    if (signal === "SIGTERM") {
      await Promise.race([
        app.close().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
      logger.info("shutdown.fast-exit");
      process.exit(0);
    }

    try {
      await app.close();
      logger.info("shutdown.complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "shutdown.error");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled-rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught-exception");
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  logger.fatal({ err }, "main.crashed");
  process.exit(1);
});
