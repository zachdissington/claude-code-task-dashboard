/**
 * Filesystem watcher — turns task-store changes into a debounced `refresh`
 * signal the SSE layer pushes to the browser.
 *
 * Watches the workspace root recursively (on Windows that is a single
 * ReadDirectoryChangesW handle, not per-file). A cheap path filter keeps only
 * task `.md` writes and the three live-state `.tmp` files; everything else
 * (node_modules churn, .git, build output) is dropped. The 30s client-side
 * safety poll covers any event the OS buffer drops under heavy churn.
 */

import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { WORKSPACE_ROOT } from "./config.js";
import { invalidate } from "./data/snapshot.js";
import { logger } from "./logger.js";

/** Emits `refresh` (no payload) when a relevant task-store change is seen. */
export const fsEvents = new EventEmitter();

const DEBOUNCE_MS = 400;

/** Decide whether a changed path (relative to workspace root) matters. */
function isRelevant(rawPath: string): boolean {
  const p = rawPath.replace(/\\/g, "/");
  if (p.includes("node_modules") || p.includes("/.git/") || p.startsWith(".git/")) {
    return false;
  }
  if (p.includes("/dist/") || p.startsWith("dist/")) return false;

  // Live-state files (exact paths only — .tmp/ is otherwise very noisy).
  if (p === ".tmp/capture_queue.json" || p === ".tmp/shipped_queue.json") return true;
  if (p.startsWith(".tmp/session_bindings/")) return true;

  // Dashboard-owned data files. Without this a CLI edit only surfaces on the
  // 30s safety poll, not instantly via SSE.
  if (p.endsWith("/data/business-metrics.json")) return true;

  // Task / reference markdown anywhere under a tasks/ or refs/ directory.
  if (p.endsWith(".md")) {
    return (
      p.includes("/tasks/") ||
      p.includes("/refs/") ||
      p.startsWith("tasks/") ||
      p.startsWith("refs/")
    );
  }
  return false;
}

export function startWatcher(): void {
  let timer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    timer = null;
    invalidate(); // next /snapshot rebuilds from disk, not stale cache
    fsEvents.emit("refresh");
  };

  try {
    const watcher = watch(
      WORKSPACE_ROOT,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        if (!isRelevant(filename.toString())) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, DEBOUNCE_MS);
      },
    );
    watcher.on("error", (err) => {
      logger.warn({ err }, "watcher.error — relying on client safety poll");
    });
    logger.info({ root: WORKSPACE_ROOT }, "watcher.started");
  } catch (err) {
    // A failed watcher is non-fatal: the 30s client poll still refreshes.
    logger.warn({ err }, "watcher.start-failed — relying on client safety poll");
  }
}
