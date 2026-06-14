/**
 * Morning auto-plan — the 7am weekday fallback that proposes a day's plan in the
 * empty "Today's plan" panel, with accept / edit / reject. (T-2026-05-29-001)
 *
 * Design (per the approved plan):
 *   - Scheduler is an IN-PROCESS timer in this always-on PM2 service (mirrors the
 *     6h trend setInterval), NOT Trigger.dev (cloud can't reach the local store)
 *     nor Windows Task Scheduler (redundant with the always-on process).
 *   - The generator reuses the canonical Python contracts — no second planner:
 *       next-task.py --json   → committed-day check (top/rest_today) + the
 *                               work-queue pull candidates (plan_sort_key order)
 *                               + overdue_count/triage_pending.
 *       plan-day.py --force   → run for its morning side effects (ingests overnight
 *                               remote captures, reads live calendar) + the
 *                               meeting-adjusted capacity + warnings. --force so the
 *                               triage gate never errors the job; the un-triaged
 *                               overdue count surfaces as a visible WARNING instead.
 *   - Only proposes when today is UNCOMMITTED (the morning fallback). If a plan
 *     already exists (evening-review, or a manual /plan-day), it's a no-op.
 *   - State lives in .tmp/morning-plan-state.json, date-keyed so a stale proposal
 *     never resurfaces and the user's accept/reject decision sticks for the day.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runPythonJson } from "./python-bridge.js";
import type { MorningPlanProposalTask, MorningPlanState } from "./types.js";

const PLAN_DAY_SCRIPT = join(config.SCRIPTS_DIR, "plan-day.py");
const NEXT_TASK_SCRIPT = join(config.SCRIPTS_DIR, "next-task.py");
const STATE_PATH = join(config.TMP_DIR, "morning-plan-state.json");

/** Default day budget if plan-day can't supply one (DAILY_CAPACITY_MIN). */
const DEFAULT_CAPACITY = 360;

/** Subset of next-task.py --json we consume. */
interface NextTaskRow {
  fs_id: string;
  title: string;
  priority: string;
  workspace_path: string;
  time_estimate: number | null;
  work_block: string | null;
  group_display: string;
}
interface NextTaskJson {
  date: string;
  top: NextTaskRow | null;
  rest_today: NextTaskRow[];
  work_queue: NextTaskRow[];
  overdue_count: number;
  triage_pending: boolean;
}
/** Subset of plan-day.py --force --date <d> we consume. */
interface PlanDayJson {
  warnings?: string[];
  summary?: { capacity_after_meetings?: number; meeting_minutes_today?: number };
}

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Read the persisted state; null when absent or unreadable (fault-tolerant). */
export async function readMorningPlanState(): Promise<MorningPlanState | null> {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw) as MorningPlanState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn({ err }, "morning-plan.state-unreadable");
    return null;
  }
}

async function writeState(state: MorningPlanState): Promise<void> {
  await mkdir(config.TMP_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Flip today's proposal to a terminal decision (accept/reject). No-op unless a
 * proposal for today exists — so a stale POST can't fabricate state. Returns the
 * state it wrote, or null when there was nothing to act on.
 */
export async function markMorningPlanState(
  status: "accepted" | "dismissed",
): Promise<MorningPlanState | null> {
  const today = localToday();
  const existing = await readMorningPlanState();
  if (!existing || existing.date !== today || existing.status !== "proposed") return null;
  const next: MorningPlanState = { ...existing, status };
  await writeState(next);
  return next;
}

export interface RunResult {
  status: MorningPlanState["status"] | "acted" | "already-proposed" | "error";
  proposedCount?: number;
}

/**
 * Generate (or refresh) today's morning proposal. Idempotent within a day: once
 * acted on (accepted/dismissed) or already proposed it's a no-op, unless
 * `force` is set (the verification/dev path).
 */
export async function runMorningPlanProposal(opts: { force?: boolean } = {}): Promise<RunResult> {
  const today = localToday();
  const generatedAt = new Date().toISOString();

  if (!opts.force) {
    const existing = await readMorningPlanState();
    if (existing && existing.date === today) {
      if (existing.status === "accepted" || existing.status === "dismissed") return { status: "acted" };
      if (existing.status === "proposed") return { status: "already-proposed" };
    }
  }

  // 1. Committed-day check via the shared resolver. top/rest_today are the
  //    scheduled-for-today tasks; if any exist the day is committed → no proposal.
  let nt: NextTaskJson;
  try {
    nt = await runPythonJson<NextTaskJson>(NEXT_TASK_SCRIPT, ["--json", "--date", today]);
  } catch (err) {
    logger.warn({ err }, "morning-plan.next-task-failed");
    return { status: "error" };
  }
  if (nt.top || (nt.rest_today && nt.rest_today.length > 0)) {
    await writeState({
      date: today, status: "committed", proposedIds: [], proposedTasks: [],
      warnings: [], triageNeeded: false, overdueCount: nt.overdue_count || 0, generatedAt,
    });
    return { status: "committed" };
  }

  // 2. Run plan-day --force for its morning side effects (remote-capture ingest,
  //    live calendar) + the meeting-adjusted budget + warnings. Best-effort: a
  //    failure here just falls back to the default capacity / no extra warnings.
  let pd: PlanDayJson = {};
  try {
    pd = await runPythonJson<PlanDayJson>(PLAN_DAY_SCRIPT, ["--force", "--date", today]);
  } catch (err) {
    logger.warn({ err }, "morning-plan.plan-day-failed");
  }
  const capacity = (pd.summary && pd.summary.capacity_after_meetings) || DEFAULT_CAPACITY;

  // 3. Fill the day from the work-queue pull candidates (already plan_sort_key
  //    ordered), greedily up to the day's budget. The top candidate is always
  //    included so an empty morning never yields an empty proposal.
  const tasks: MorningPlanProposalTask[] = [];
  let used = 0;
  for (const r of nt.work_queue || []) {
    const est = r.time_estimate || 0;
    if (tasks.length > 0 && used + est > capacity) continue;
    tasks.push({
      id: r.fs_id,
      title: r.title,
      project: r.group_display || r.workspace_path,
      priority: r.priority || "",
      estMin: est,
      workBlock: r.work_block || null,
      workspacePath: r.workspace_path,
    });
    used += est;
  }

  if (tasks.length === 0) {
    await writeState({
      date: today, status: "empty", proposedIds: [], proposedTasks: [],
      warnings: [], triageNeeded: false, overdueCount: nt.overdue_count || 0, generatedAt,
    });
    return { status: "empty" };
  }

  // 4. Warnings: plan-day's own + a synthesized triage nudge (preserving the
  //    triage gate's INTENT — don't silently plan over un-triaged overdue).
  const warnings = [...(pd.warnings || [])];
  if (nt.triage_pending && (nt.overdue_count || 0) > 0) {
    warnings.unshift(`${nt.overdue_count} overdue need triage`);
  }

  await writeState({
    date: today,
    status: "proposed",
    proposedIds: tasks.map((t) => t.id),
    proposedTasks: tasks,
    warnings,
    triageNeeded: !!nt.triage_pending,
    overdueCount: nt.overdue_count || 0,
    capacity,
    generatedAt,
  });
  return { status: "proposed", proposedCount: tasks.length };
}

/** ms until the next weekday 07:00 local. */
function msUntilNextWeekday7am(now: Date): number {
  const target = new Date(now);
  target.setHours(7, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  // Skip Sat (6) / Sun (0) — the proposal is a weekday morning ritual.
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

let timer: NodeJS.Timeout | null = null;

/**
 * Arm the weekday-07:00 timer (re-arms after each fire). Also does one guarded
 * boot catch-up: if the process (re)started during a weekday morning and today
 * has no decision yet, propose now — so a restart after 7am still gets a plan
 * (mirrors the boot-snapshot the trend timer does). If the PC sleeps THROUGH
 * 7am, the live timer fires on wake and still stamps today (date-checked).
 */
export function armMorningPlanScheduler(): void {
  const arm = (): void => {
    const ms = msUntilNextWeekday7am(new Date());
    timer = setTimeout(() => {
      void runMorningPlanProposal()
        .catch((err) => {
          logger.warn({ err }, "morning-plan.fire-failed");
          return undefined;
        })
        .finally(arm); // re-arm for the next weekday regardless of outcome
    }, ms);
    timer.unref();
  };
  arm();

  // Boot catch-up: weekday, between 07:00 and noon, fire once (idempotent — the
  // generator no-ops if today is committed or already decided).
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (day >= 1 && day <= 5 && hour >= 7 && hour < 12) {
    void runMorningPlanProposal().catch((err) =>
      logger.warn({ err }, "morning-plan.boot-catchup-failed"),
    );
  }
}
