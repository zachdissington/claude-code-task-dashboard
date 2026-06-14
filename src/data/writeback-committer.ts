/**
 * Debounced auto-committer for the dashboard's OWN write-backs.
 *
 * The board writes to the task store as you use it — meal/training tick-offs
 * (POST /action) and the daily trend point (trend-store). Between commits these
 * accumulate as uncommitted git-status noise. This module coalesces that activity
 * and, once it settles, spawns `commit_dashboard_writebacks.py` which commits ONLY
 * the dashboard's churn folders, by pathspec (never another terminal's work).
 *
 * Best-effort: a commit failure is logged, never thrown — it must not affect a
 * write-back response or the trend write.
 */

import { execFile } from "node:child_process";
import { config, WORKSPACE_ROOT } from "../config.js";
import { logger } from "../logger.js";

let debounceTimer: NodeJS.Timeout | null = null;
let firstScheduledAt = 0; // start of the current deferral window (for the max-wait cap)
let inFlight = false;

function runCommit(): void {
  if (inFlight) return; // never overlap commits; the next write-back reschedules
  inFlight = true;
  firstScheduledAt = 0;
  execFile(
    config.PYTHON_BIN,
    [config.AUTOCOMMIT_SCRIPT, "--workspace", WORKSPACE_ROOT],
    { timeout: config.PYTHON_TIMEOUT_MS, cwd: WORKSPACE_ROOT },
    (err, stdout, stderr) => {
      inFlight = false;
      if (err) {
        logger.warn({ err, stderr }, "autocommit.spawn-failed");
        return;
      }
      try {
        const res = JSON.parse((stdout || "").trim() || "{}") as {
          committed?: boolean;
          detail?: string;
          count?: number;
          error?: string;
        };
        if (res.committed) {
          logger.info({ detail: res.detail, count: res.count }, "autocommit.committed");
        } else if (res.error) {
          logger.warn({ error: res.error }, "autocommit.skipped");
        }
      } catch {
        logger.warn({ stdout }, "autocommit.unparseable");
      }
    },
  );
}

/**
 * Note that a write-back happened. Debounces: fires `AUTOCOMMIT_DEBOUNCE_MS` after
 * the LAST call, but never defers past `AUTOCOMMIT_MAX_WAIT_MS` from the first call
 * of a burst (so continuous activity still checkpoints). No-op when AUTO_COMMIT off.
 */
export function scheduleWritebackCommit(): void {
  if (!config.AUTO_COMMIT) return;
  const now = Date.now();
  if (!firstScheduledAt) firstScheduledAt = now;

  if (now - firstScheduledAt >= config.AUTOCOMMIT_MAX_WAIT_MS) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    runCommit();
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runCommit();
  }, config.AUTOCOMMIT_DEBOUNCE_MS);
  debounceTimer.unref?.(); // never hold the process open for a pending commit
}

/** Drop any pending commit timer (shutdown). The residual churn commits on next activity. */
export function cancelPendingCommit(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
