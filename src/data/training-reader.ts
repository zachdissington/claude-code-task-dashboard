/**
 * Training reader — feeds the Personal view's "Today's training" panel.
 *
 * Two sources, fault-tolerant by construction:
 *   - suggest_training.py  — the next session in the Upper/Lower rotation
 *     (reuses the training-system rotation logic; not reimplemented here).
 *   - training-system/tasks — scanned directly for a task scheduled today and
 *     its completion status.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { readTaskDir } from "./frontmatter.js";
import { runPythonJson } from "./python-bridge.js";
import type { ProgressionHint, TrainingExercise, TrainingToday } from "./types.js";

/** Parse the `## Notes` `- ` bullets (the exercise list) from a task file body. */
async function readExercises(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, "utf-8");
    const idx = text.indexOf("## Notes");
    const body = idx >= 0 ? text.slice(idx) : text;
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse the structured `## Session` table (exercise/target/last/log) — mirrors
 *  the Python session_model.parse_session_table. [] when absent (endurance /
 *  legacy tasks). Tolerant: a malformed table yields []. (T-2026-05-31-002) */
async function readSession(path: string): Promise<TrainingExercise[]> {
  try {
    const text = await readFile(path, "utf-8");
    const idx = text.indexOf("## Session");
    if (idx < 0) return [];
    // Stop at the next H2 so a later section's pipes aren't slurped in.
    const section = text.slice(idx + "## Session".length).split(/\n##\s/)[0];
    const rows: TrainingExercise[] = [];
    for (const raw of section.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("|")) continue;
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length < 4) continue;
      const head = cells[0].toLowerCase();
      if (head === "exercise" || head === "") continue; // header row
      if (/^[-:\s]+$/.test(cells[0])) continue; // |---| separator
      rows.push({
        exercise: cells[0],
        target: cells[1],
        last: cells[2] === "—" ? "" : cells[2],
        log: cells[3],
      });
    }
    return rows;
  } catch {
    return [];
  }
}

interface SuggestOutput {
  rest_recommended?: boolean;
  last_session?: string | null;
  last_session_date?: string | null;
  next_session?: string | null;
  exercises?: string[];
  progression?: Record<string, ProgressionHint>;
  error?: string;
}

function localToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function readTraining(): Promise<TrainingToday> {
  const today = localToday();
  const base: TrainingToday = {
    nextSession: null,
    exercises: [],
    restRecommended: false,
    lastSession: null,
    lastSessionDate: null,
    todayScheduled: false,
    todayComplete: false,
    todayTitle: null,
    todayId: null,
    todayWorkspacePath: "Internal/training-system",
    todayExercises: [],
    todaySession: [],
    progression: {},
  };

  // 1. Scan today's scheduled training task (independent of the suggester).
  try {
    const tasks = await readTaskDir(config.TRAINING_TASKS_DIR);
    // Only the auto-generated routine session ("Training — …" / routine:true) is
    // today's workout. Project/operational training-system tasks belong on the
    // backlog, not this panel. (2026-06-13)
    const isSessionRoutine = (fm: Record<string, string>) =>
      fm.routine === "true" || /^training\s*[—–-]\s/i.test(fm.title || "");
    for (const t of tasks) {
      if (t.fm.type && t.fm.type !== "task") continue;
      if (!isSessionRoutine(t.fm)) continue;
      if ((t.fm.scheduled_date || "").slice(0, 10) === today) {
        base.todayScheduled = true;
        base.todayTitle = t.fm.title || null;
        base.todayComplete = t.fm.status === "complete";
        base.todayId = t.fm.id || null;
        base.todayExercises = await readExercises(t.path);
        base.todaySession = await readSession(t.path);
        break;
      }
    }
  } catch (err) {
    base.error = `training tasks unreadable: ${String(err)}`;
  }

  // 2. Suggest the next session (rotation logic lives in the Python script).
  try {
    const s = await runPythonJson<SuggestOutput>(config.SUGGEST_TRAINING_SCRIPT);
    base.restRecommended = Boolean(s.rest_recommended);
    base.nextSession = s.next_session ?? null;
    base.exercises = Array.isArray(s.exercises) ? s.exercises : [];
    base.lastSession = s.last_session ?? null;
    base.lastSessionDate = s.last_session_date ?? null;
    base.progression = s.progression ?? {};
  } catch (err) {
    base.error = base.error
      ? `${base.error}; suggester failed: ${String(err)}`
      : `suggest_training.py failed: ${String(err)}`;
  }

  return base;
}
