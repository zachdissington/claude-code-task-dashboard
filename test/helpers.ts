/**
 * Shared test helpers for the write-back endpoint.
 *
 * SAFETY: round-trip tests touch the LIVE workspace store (the real update-task.py
 * is the writer under test — mocking it would defeat the point).
 * To stay non-destructive:
 *   - task tests create THROWAWAY task files with a sentinel 2099 id and
 *     scheduled_date:null, then delete them in afterEach (they never appear in
 *     any "today" panel).
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../src/config.js";
import { buildDashboardApp } from "../src/server/dashboard-app.js";

const execFileAsync = promisify(execFile);

export const TOKEN = "test-write-token-do-not-ship";

/** Headers that pass the Origin + Host + token guards. */
export function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    host: `localhost:${config.PORT}`,
    origin: `http://localhost:${config.PORT}`,
    "x-dashboard-token": TOKEN,
    ...overrides,
  };
}

export async function makeApp() {
  const app = await buildDashboardApp();
  await app.ready();
  return app;
}

/** Write a minimal valid throwaway task .md; returns its absolute path. */
export function writeThrowawayTask(opts: {
  id: string;
  workspacePath: "Internal/meal-system" | "Internal/training-system";
  title?: string;
}): string {
  const dir = opts.workspacePath === "Internal/meal-system" ? config.MEAL_TASKS_DIR : config.TRAINING_TASKS_DIR;
  const path = join(dir, `${opts.id}.md`);
  const fm = [
    "---",
    `title: ${opts.title || "TEST throwaway — safe to delete"}`,
    "type: task",
    "status: open",
    "priority: low",
    `workspace_path: ${opts.workspacePath}`,
    "scheduled_date: null",
    "created: '2099-12-31T00:00:00Z'",
    "last_completed: null",
    `id: ${opts.id}`,
    "---",
    "",
    `# ${opts.title || "TEST throwaway"}`,
    "",
  ].join("\n");
  writeFileSync(path, fm, "utf-8");
  return path;
}

/** Parse the flat frontmatter of a task file into a string map. */
export function readFrontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function deleteIfExists(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

/** Snapshot/restore .tmp/review-state.json around a test that writes it. */
export function backupReviewState(): () => void {
  const path = config.REVIEW_STATE_PATH;
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf-8") : null;
  return () => {
    if (original === null) deleteIfExists(path);
    else writeFileSync(path, original, "utf-8");
  };
}

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Local today / tomorrow (YYYY-MM-DD) — the dates the planning write kinds accept. */
export function todayDate(): string { return dateOffset(0); }
export function tomorrowDate(): string { return dateOffset(1); }

/**
 * Snapshot every meal + training task scheduled for `date`, returning a restore
 * fn. The meals-pick/training-schedule round-trips write to the REAL store; this
 * captures + fully restores that day so a real plan is never clobbered.
 */
export function backupDatedTasks(date: string): () => void {
  const tmr = date;
  const dirs = [config.MEAL_TASKS_DIR, config.TRAINING_TASKS_DIR];
  const matches = (p: string): boolean => {
    try {
      return new RegExp(`scheduled_date:\\s*'?${tmr}`).test(readFileSync(p, "utf-8"));
    } catch {
      return false;
    }
  };
  const list = (): string[] => {
    const out: string[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = join(dir, f);
        if (matches(p)) out.push(p);
      }
    }
    return out;
  };
  const saved = list().map((p) => ({ path: p, content: readFileSync(p, "utf-8") }));
  return () => {
    for (const p of list()) deleteIfExists(p); // remove whatever the test left
    for (const s of saved) writeFileSync(s.path, s.content, "utf-8"); // restore originals
  };
}
export function backupTomorrowTasks(): () => void { return backupDatedTasks(tomorrowDate()); }

/** Run a workspace script directly (used by the concurrency test's second writer). */
export async function runScript(script: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  try {
    await execFileAsync(config.PYTHON_BIN, [script, ...args], { cwd: process.cwd(), windowsHide: true });
    return { ok: true, stderr: "" };
  } catch (e) {
    return { ok: false, stderr: String((e as { stderr?: string }).stderr || (e as Error).message) };
  }
}

export { config };
