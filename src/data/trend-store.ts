/**
 * Backlog-size trend store — data/backlog-history.json.
 *
 * The always-on PM2 process self-accumulates the trend: every snapshot build
 * upserts the record for today (keyed on date) — appended if absent, otherwise
 * overwritten so the plotted point tracks the live count as work ships through
 * the day. Prior days stay frozen. No cron — keeping accumulation inside the
 * live process is one fewer moving part. PC-off days are simply absent; the
 * chart plots by date so gaps are honest.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot truncate
 * the history. The reader tolerates a missing or malformed file as empty.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { TrendPoint } from "./types.js";
import { scheduleWritebackCommit } from "./writeback-committer.js";

function today(): string {
  // Local date — the dashboard runs on Zach's PC; local day boundaries are
  // what "one point per day" should mean.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Read the full trend history. Missing/malformed file -> []. */
export async function readHistory(): Promise<TrendPoint[]> {
  try {
    const raw = await readFile(config.HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrendPoint[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err }, "trend.history-unreadable — treating as empty");
    }
    return [];
  }
}

async function writeHistory(points: TrendPoint[]): Promise<void> {
  await mkdir(dirname(config.HISTORY_PATH), { recursive: true });
  const tmp = join(
    dirname(config.HISTORY_PATH),
    `.backlog-history.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(points, null, 2) + "\n", "utf-8");
  await rename(tmp, config.HISTORY_PATH);
}

/**
 * Upsert today's backlog point: appended if today is absent, otherwise
 * overwritten in place so the plotted point reflects the live count as work
 * ships through the day. Prior-day points are never touched. A no-op write is
 * skipped when today's total is unchanged. Returns the full history.
 */
export async function upsertToday(
  total: number,
  perProject: Record<string, number>,
): Promise<TrendPoint[]> {
  const history = await readHistory();
  const date = today();
  const point: TrendPoint = { date, total, per_project: perProject };
  const existing = history.find((p) => p.date === date);
  if (existing && existing.total === total) {
    return history; // nothing changed — avoid a pointless disk write
  }
  const updated = existing
    ? history.map((p) => (p.date === date ? point : p))
    : [...history, point].sort((a, b) => a.date.localeCompare(b.date));
  try {
    await writeHistory(updated);
    logger.info({ date, total }, "trend.upserted");
    // The trend file actually changed on disk — checkpoint it (debounced, best-effort).
    scheduleWritebackCommit();
  } catch (err) {
    logger.warn({ err }, "trend.upsert-failed — point not persisted");
    return history;
  }
  return updated;
}
