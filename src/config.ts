/**
 * Configuration — resolved at import time. Most settings come from this file;
 * a few (ANTHROPIC_*, TASK_DASHBOARD_*) can be overridden via the workspace
 * `.env` file, loaded once below into process.env so every module that reads
 * process.env sees the values.
 *
 * WORKSPACE_ROOT is found by walking up from this file until a directory
 * containing `.claude/` is seen. The compiled file lives at
 * Internal/task-dashboard/dist/config.js, so the walk is: dist -> task-dashboard
 * -> Internal -> <workspace root, has .claude>.
 *
 * TOOL_ROOT is this tool's own folder (Internal/task-dashboard) — `data/` files
 * the dashboard owns (trend, business metrics) live under it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveWorkspaceRoot(): string {
  // Explicit override wins — set this when the dashboard lives outside the
  // workspace it reports on.
  if (process.env.TASK_DASHBOARD_WORKSPACE_ROOT) {
    return process.env.TASK_DASHBOARD_WORKSPACE_ROOT;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  const toolRoot = dirname(dir); // dist -> repo root
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".claude")) && existsSync(join(dir, ".claude", "scripts"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No workspace found — e.g. a standalone/public clone, typically run in
  // DASHBOARD_DEMO mode. Fall back to this tool's own root; demo mode serves
  // bundled fixtures and never touches the (absent) workspace script paths.
  return toolRoot;
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

/**
 * Minimal `.env` loader — KEY=VALUE per line, # comments, optional quotes.
 * Existing process.env entries win (so PM2/shell exports always override).
 * No dependency, no surprises.
 */
function loadDotenv(root: string): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadDotenv(WORKSPACE_ROOT);

/** This tool's own folder — dist/config.js -> dist -> task-dashboard. */
export const TOOL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DATA_DIR = join(TOOL_ROOT, "data");

const PORT = Number(process.env.TASK_DASHBOARD_PORT) || 8790;

export const config = {
  /** Demo mode — for standalone/public clones with no workspace task store.
   *  When set (DASHBOARD_DEMO=1), the Python bridge serves the bundled mock
   *  fixtures under `mocks/` instead of shelling out to `.claude/scripts`, so
   *  the dashboard renders end-to-end with no backend, no Python, no workspace. */
  DEMO: process.env.DASHBOARD_DEMO === "1" || process.env.DASHBOARD_DEMO === "true",

  /** Localhost-only dashboard port. 8787/8788 belong to voice-jarvis. */
  PORT,

  /** Origins allowed to POST /action — blocks cross-site/DNS-rebinding writes
   *  from any page the browser happens to be visiting. localhost by default;
   *  set DASHBOARD_PUBLIC_ORIGIN (the Cloudflare Tunnel hostname, e.g.
   *  https://dash.example.com) to also accept the mobile/tunnel origin. Unset ⇒
   *  localhost-only (unchanged). The Origin+Host guards derive off this list. */
  WRITE_ORIGINS: [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    ...(process.env.DASHBOARD_PUBLIC_ORIGIN ? [process.env.DASHBOARD_PUBLIC_ORIGIN.replace(/\/$/, "")] : []),
  ],

  /** Python interpreter used to run the workspace task-store scripts. */
  PYTHON_BIN: process.env.TASK_DASHBOARD_PYTHON || "python",

  /** Directory holding the workspace task-store scripts. */
  SCRIPTS_DIR: join(WORKSPACE_ROOT, ".claude", "scripts"),

  /** Task-mutation CLI — the SAME writer the Claude Code flow uses. The write
   *  endpoint shells out to this so there is one writer implementation, no drift. */
  UPDATE_TASK_SCRIPT: join(WORKSPACE_ROOT, ".claude", "scripts", "update-task.py"),

  /** Shared secret guarding every write (POST /action). Empty ⇒ writes disabled
   *  (fail-safe). Set DASHBOARD_WRITE_TOKEN in the workspace .env. */
  WRITE_TOKEN: process.env.DASHBOARD_WRITE_TOKEN || "",

  /** Offline durability (Part C) — the always-on Cloudflare outbox Worker.
   *  OUTBOX_URL + OUTBOX_ADMIN_TOKEN unset ⇒ drain is a no-op (inert until Zach
   *  deploys the Worker). OUTBOX_TOKEN is injected into the page so the phone can
   *  enqueue when the PC/tunnel is down; ADMIN token is PC-only (drains/acks). */
  OUTBOX_URL: (process.env.DASHBOARD_OUTBOX_URL || "").replace(/\/$/, ""),
  OUTBOX_TOKEN: process.env.DASHBOARD_OUTBOX_TOKEN || "",
  OUTBOX_ADMIN_TOKEN: process.env.DASHBOARD_OUTBOX_ADMIN_TOKEN || "",
  OUTBOX_APPLIED_PATH: join(TOOL_ROOT, ".tmp", "outbox-applied.json"),

  /** Directory holding live `.tmp` state files. */
  TMP_DIR: join(WORKSPACE_ROOT, ".tmp"),

  /** Evening-review freshness stamp — written by .claude/scripts/record-review.py
   *  when the review closes; read-only here. Drives the "last reviewed" line +
   *  after-7pm stale nudge on the Tomorrow panel. Absent file ⇒ never reviewed. */
  REVIEW_STATE_PATH: join(WORKSPACE_ROOT, ".tmp", "review-state.json"),

  /** Backlog-trend history file (committed; lives inside this tool). */
  HISTORY_PATH: join(DATA_DIR, "backlog-history.json"),

  /** Today-plan manifest — which tasks were scheduled today at any point, so
   *  the Today's plan panel can show completed/rescheduled instead of letting
   *  them vanish silently. Self-resets daily (only today's key is kept). */
  TODAY_MANIFEST_PATH: join(DATA_DIR, "today-plan-manifest.json"),

  /** Manually-maintained business KPI file (updated via Claude Code). */
  BUSINESS_METRICS_PATH: join(DATA_DIR, "business-metrics.json"),

  /** Optional manual layer for the Client commitments panel — next deliverable
   *  + due date per client. Absent file is fine; auto counts still render. */
  CLIENT_COMMITMENTS_PATH: join(DATA_DIR, "client-commitments.json"),

  /** Claude Code session transcripts — source for the token-spend panel. */
  CLAUDE_PROJECTS_DIR: join(homedir(), ".claude", "projects"),

  /** Favicon served at /favicon.ico — becomes the app-window taskbar icon. */
  ICON_PATH: join(TOOL_ROOT, "assets", "dashboard-icon.ico"),

  /** training-system suggester script + its task store. */
  SUGGEST_TRAINING_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "training-system", "scripts", "suggest_training.py",
  ),
  TRAINING_TASKS_DIR: join(WORKSPACE_ROOT, "Internal", "training-system", "tasks"),

  /** meal-system task store. */
  MEAL_TASKS_DIR: join(WORKSPACE_ROOT, "Internal", "meal-system", "tasks"),

  /** meal-system inventory-ranked suggester (top-N per slot, 5 feedings). */
  SUGGEST_MEALS_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "meal-system", "scripts", "suggest_meals.py",
  ),
  /** meal-system weigh-in logger — the single shared writer/reader for the
   *  nutrition control loop (--status reads, --weight writes). */
  LOG_WEIGHT_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "meal-system", "scripts", "log_weight.py",
  ),
  /** meal/training task creators — the Tomorrow lane's write path. */
  CREATE_MEAL_TASKS_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "meal-system", "scripts", "create_meal_tasks.py",
  ),
  CREATE_TRAINING_TASK_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "training-system", "scripts", "create_training_task.py",
  ),
  /** Progressive-overload logging — writes a set into a task's ## Session table. */
  LOG_TRAINING_SET_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "training-system", "scripts", "log_training_set.py",
  ),
  /** Task-file validator — post-create gate for the write endpoint. */
  VALIDATE_TASK_SCRIPT: join(
    WORKSPACE_ROOT, ".claude", "skills", "session-capture", "scripts", "validate_task.py",
  ),

  /** Google Calendar window reader — live PULL, no cached mirror (see
   *  .claude/plans/2026-05-29-calendar-in-plan-day.md). */
  CALENDAR_WINDOW_SCRIPT: join(
    WORKSPACE_ROOT, "Internal", "virtual-assistant-agent", "scripts", "calendar-read-window.py",
  ),

  /** Snapshot cache TTL — caps Python spawns under rapid SSE re-fetches. */
  SNAPSHOT_TTL_MS: 4000,

  /** Python script spawn timeout. */
  PYTHON_TIMEOUT_MS: 20000,

  /** Claude Code OAuth credentials — read fresh per call for the rate-limit
   *  reader (Claude Code auto-refreshes the access token here). */
  CLAUDE_CREDENTIALS_PATH: join(homedir(), ".claude", ".credentials.json"),

  /** Undocumented-but-stable endpoint the Claude desktop app uses for the
   *  5h/weekly window utilization. The User-Agent MUST start with
   *  `claude-code/` or the endpoint 429s aggressively for ~30min. */
  OAUTH_USAGE_URL: "https://api.anthropic.com/api/oauth/usage",
  OAUTH_USAGE_BETA: "oauth-2025-04-20",
  CLAUDE_CODE_UA: "claude-code/2.1.157",

  /** Rate-limit reader own cache — must stay >=180s to avoid the 429 trap. */
  RATELIMIT_TTL_MS: 300_000,

  /** Auto-commit the dashboard's OWN write-backs (meal/training tick-offs +
   *  the daily trend point) so they don't pile up as uncommitted git noise. Default
   *  on; set DASHBOARD_AUTO_COMMIT=false to disable. Commits ONLY the dashboard's
   *  churn folders, by pathspec — never another terminal's work. Plan:
   *  Internal/task-dashboard/plans/2026-06-04-dashboard-autocommit-writebacks.md. */
  AUTO_COMMIT: process.env.DASHBOARD_AUTO_COMMIT !== "false",
  AUTOCOMMIT_SCRIPT: join(
    WORKSPACE_ROOT, ".claude", "scripts", "commit_dashboard_writebacks.py",
  ),
  /** Quiet window before an auto-commit fires, reset on each new write-back. */
  AUTOCOMMIT_DEBOUNCE_MS: 120_000,
  /** Hard cap so continuous activity still commits within this bound. */
  AUTOCOMMIT_MAX_WAIT_MS: 600_000,
} as const;
