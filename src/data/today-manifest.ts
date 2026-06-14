/**
 * Today-plan manifest — data/today-plan-manifest.json.
 *
 * Records every professional task that was scheduled for today at any point
 * during the day, so the Today's plan panel can show what HAPPENED to a task
 * that left the plan (completed vs rescheduled away) instead of letting it
 * vanish silently. This is the fix for the 2026-06-01 finding: a mid-day
 * reschedule and a completion looked identical (both just disappeared).
 *
 * Same atomic-write pattern as trend-store. Only today's key is kept — prior
 * dates are pruned on write (the Closures panel owns history). The manifest is
 * dashboard-owned data (like backlog-history.json); it never writes to the
 * task store, preserving the read-only invariant.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { BurndownGroup, TodayMovementItem } from "./types.js";

interface ManifestEntry {
  title: string;
  project: string;
  fs_path: string;
  priority: string;
  work_block: string | null;
  time_estimate: number;
}

/** date (YYYY-MM-DD) -> fs_path -> entry. Keyed by fs_path: task ids (fs_id /
 *  notion hex) can collide across projects; absolute paths cannot. */
type Manifest = Record<string, Record<string, ManifestEntry>>;

export interface TodayMovement {
  completedToday: TodayMovementItem[];
  movedAway: TodayMovementItem[];
}

export const EMPTY_MOVEMENT: TodayMovement = { completedToday: [], movedAway: [] };

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Read the manifest. Missing/malformed file -> {}. */
async function readManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(config.TODAY_MANIFEST_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Manifest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err }, "today-manifest.unreadable — treating as empty");
    }
    return {};
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  await mkdir(dirname(config.TODAY_MANIFEST_PATH), { recursive: true });
  const tmp = join(
    dirname(config.TODAY_MANIFEST_PATH),
    `.today-plan-manifest.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(m, null, 2) + "\n", "utf-8");
  await rename(tmp, config.TODAY_MANIFEST_PATH);
}

/**
 * Union today's scheduled professional tasks into the manifest, then diff:
 * any manifest entry no longer "open and scheduled today" is classified as
 * completed (gone from the open-task set entirely — burndown only emits open
 * tasks) or moved (still open, but scheduled_date is now in the future).
 *
 * A write only happens when the manifest content actually changes, mirroring
 * trend-store's no-op-write guard.
 */
export async function recordAndDiffToday(
  groups: BurndownGroup[],
  isPersonal: (project: string) => boolean,
): Promise<TodayMovement> {
  const today = localToday();

  // Index the current open-task set by fs_path; collect today's scheduled set.
  const openByPath = new Map<string, { scheduled_date: string | null }>();
  const scheduledToday = new Map<string, ManifestEntry>();
  for (const g of groups) {
    for (const t of g.tasks) {
      if (!t.fs_path) continue;
      openByPath.set(t.fs_path, { scheduled_date: t.scheduled_date });
      if (t.scheduled_date === today && !isPersonal(t.project)) {
        scheduledToday.set(t.fs_path, {
          title: t.title,
          project: t.project,
          fs_path: t.fs_path,
          priority: t.priority,
          work_block: t.work_block,
          time_estimate: t.time_estimate || 0,
        });
      }
    }
  }

  const manifest = await readManifest();
  const todayMap: Record<string, ManifestEntry> = manifest[today] || {};

  // Union currently-scheduled tasks into today's manifest.
  let changed = !manifest[today] || Object.keys(manifest).length !== 1;
  for (const [path, entry] of scheduledToday) {
    if (!todayMap[path]) {
      todayMap[path] = entry;
      changed = true;
    }
  }

  if (changed) {
    try {
      await writeManifest({ [today]: todayMap });
    } catch (err) {
      logger.warn({ err }, "today-manifest.write-failed — movement still derived from memory");
    }
  }

  // Diff: manifest entries that are no longer on today's plan.
  const movement: TodayMovement = { completedToday: [], movedAway: [] };
  for (const [path, entry] of Object.entries(todayMap)) {
    if (scheduledToday.has(path)) continue; // still on the plan
    const open = openByPath.get(path);
    if (!open) {
      // Not in the open set at all -> closed (complete or archived).
      movement.completedToday.push({ ...entry });
    } else {
      // Still open but scheduled away from today.
      movement.movedAway.push({ ...entry, newDate: open.scheduled_date });
    }
  }
  return movement;
}
