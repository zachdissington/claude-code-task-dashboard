/**
 * Snapshot assembler — fans out to the python bridge + state-file readers +
 * trend store, assembles one DashboardSnapshot.
 *
 * A short-TTL in-memory cache caps how often burndown.py is spawned under rapid
 * SSE-driven re-fetches. `invalidate()` clears the cache so the next build is
 * fresh — the watcher calls it on a real filesystem change so a CLI task edit
 * is reflected immediately, not after the TTL.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runBurndown, runPythonAction, runPythonJson } from "./python-bridge.js";
import {
  readCaptureQueue,
  readSessionBindings,
  readShippedQueue,
} from "./state-files.js";
import { upsertToday, readHistory } from "./trend-store.js";
import { recordAndDiffToday, EMPTY_MOVEMENT } from "./today-manifest.js";
import { readTokenSpend } from "./token-reader.js";
import { readApiSpend } from "./anthropic-api-reader.js";
import { readRateLimits } from "./oauth-usage-reader.js";
import { readBusiness } from "./business-reader.js";
import { readTraining } from "./training-reader.js";
import { readMeals } from "./meal-reader.js";
import { readWeight } from "./weight-reader.js";
import { readTomorrow } from "./tomorrow-reader.js";
import { readReviewState } from "./review-reader.js";
import { readCalendar } from "./calendar-reader.js";
import { readMorningPlanState } from "./morning-plan.js";
import {
  readClientCommitments,
  type ClientCommitmentEntry,
} from "./client-commitments-reader.js";
import type {
  ApiSpend,
  BindingRecord,
  BurndownGroup,
  CalendarToday,
  ClientCommitment,
  ClosuresData,
  DashboardSnapshot,
  RateLimits,
  TodayPlan,
  TomorrowLane,
  TrendPoint,
} from "./types.js";

const CLOSURES_SCRIPT = join(config.SCRIPTS_DIR, "closures-since.py");
const EMPTY_API_SPEND: ApiSpend = {
  today: 0,
  month: 0,
  daily: [],
  source: "unavailable",
  error: "api spend reader failed",
};
const EMPTY_RATELIMITS: RateLimits = {
  fiveHour: null,
  sevenDay: null,
  source: "unavailable",
  error: "rate-limit reader failed",
};
const EMPTY_CLOSURES: ClosuresData = {
  windowDays: 14,
  total: 0,
  daily: [],
  recent: [],
  error: "closures reader failed",
};
const EMPTY_CALENDAR: CalendarToday = {
  today: [],
  prepHorizon: [],
  meetingMinutesToday: 0,
  error: "calendar reader failed",
};
const EMPTY_TOMORROW: TomorrowLane = {
  date: "",
  planned: false,
  meals: [],
  training: { scheduled: null, suggestion: null, restRecommended: false, rotation: [] },
  thaw: [],
  error: "tomorrow reader failed",
};

/** Run a fault-tolerant reader; an unexpected throw becomes `fallback`. */
function safe<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  return p.catch((err) => {
    logger.warn({ err, label }, "snapshot.reader-threw");
    return fallback;
  });
}

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Daily stale-schedule sweep — the "auto plan-day" that replaced overdue/triage.
 * Once per day, when the date advances, clear past-due `scheduled_date` back to
 * the Work Queue via sweep-stale-schedule.py. Runs here (the always-on server),
 * never in a Claude session — so it respects stay-quiet-on-session-start.
 *
 * Records the attempt to `.tmp/last_sweep.json` BEFORE running so a failing
 * sweep can't re-spawn python on every 4s snapshot; a real failure simply isn't
 * retried until tomorrow (the dashboard already hides past-due as backlog, so a
 * missed sweep is cosmetic, not a correctness gap). Fault-tolerant throughout.
 */
const LAST_SWEEP_PATH = join(config.TMP_DIR, "last_sweep.json");
async function maybeSweep(today: string): Promise<void> {
  try {
    const j = JSON.parse(await readFile(LAST_SWEEP_PATH, "utf-8"));
    if (j && j.date === today) return; // already swept today
  } catch {
    /* missing / malformed marker → sweep */
  }
  try {
    await writeFile(LAST_SWEEP_PATH, JSON.stringify({ date: today, at: new Date().toISOString() }));
  } catch (err) {
    logger.warn({ err }, "snapshot.sweep-marker-write-failed");
  }
  const r = await runPythonAction(config.SWEEP_STALE_SCRIPT, ["--date", today]);
  if (!r.ok) logger.warn({ stderr: r.stderr.trim() }, "snapshot.sweep-failed");
  else logger.info({ out: r.stdout.trim().slice(0, 200) }, "snapshot.sweep-ok");
}

// Classification moved upstream (2026-06-13): burndown.py now drops auto-generated
// daily ROUTINE rows (meal slots / training session) via is_routine_task, so the
// groups reaching here are real work only. meal/training PROJECT tasks group like
// any project and count toward the backlog — no folder-based exclusion here. The
// right-rail meal/training panels are fed independently by meal-reader/training-reader.

/**
 * Derive the committed daily plan from the open-task set burndown already
 * produced — tasks scheduled for today, split professional vs personal. Past-due
 * tasks are NOT counted as overdue (the concept was retired 2026-06-20); they
 * simply aren't "today" and live in the Work Queue. No extra scan.
 */
function deriveTodayPlan(groups: BurndownGroup[], bindings: BindingRecord[] = []): TodayPlan {
  const today = localToday();
  // In-flight (session-bound) tasks belong in the in-flight panel, not the day
  // plan — the same split plan-day.py + next-task.py make. Match on fs_path
  // (collision-proof; fs_ids repeat across projects), fall back to task_id for
  // legacy bindings without a path.
  const boundPaths = new Set(bindings.filter((b) => b.task_fs_path).map((b) => b.task_fs_path));
  const boundIds = new Set(
    bindings.filter((b) => b.task_id && !b.task_fs_path).map((b) => b.task_id),
  );
  const tp: TodayPlan = {
    professional: [],
    personal: [],
    committedMinutesPro: 0,
    committedMinutesPersonal: 0,
    dailyCapacityMin: 0, // real values set by the caller (needs calendar + budget)
    availableMinutes: 0,
    remainingMinutes: 0,
    completedToday: [],
    movedAway: [],
  };
  for (const g of groups) {
    for (const t of g.tasks) {
      // Parked: not in today's plan, not overdue. Honors the Phase-2 typed
      // readiness fields (waiting_on / depends_on) alongside legacy blocked_by.
      if (t.blocked_by || t.waiting_on || (t.depends_on && t.depends_on.length)) continue;
      if (boundPaths.has(t.fs_path) || boundIds.has(t.id)) continue; // in-flight: lives in the in-flight panel
      const sd = t.scheduled_date;
      if (!sd) continue;
      // Routine rows are dropped upstream by burndown; everything here is real work,
      // so it all renders in the professional Today's plan (incl. meal/training
      // PROJECT tasks). (2026-06-13)
      const personal = false;
      if (sd === today) {
        if (personal) {
          tp.personal.push(t);
          tp.committedMinutesPersonal += t.time_estimate || 0;
        } else {
          tp.professional.push(t);
          tp.committedMinutesPro += t.time_estimate || 0;
        }
      }
      // Past-due (sd < today) is no longer special-cased — the task stays in the
      // Work Queue and the daily sweep clears its stale date. (2026-06-20)
    }
  }
  return tp;
}

/**
 * Build the Client commitments rows: open + high-priority counts from the
 * burndown client groups (project prefix `Clients/`), merged with the manual
 * next-deliverable / due-date layer. Sorted high-priority-count first, then
 * open-count — reputation risk leads. (Caveat: a client task tagged only with
 * a bare `client:` frontmatter value and no workspace_path groups under the
 * client name, not `Clients/<name>`, and is missed — accepted for v1.)
 */
function buildClientCommitments(
  proGroups: BurndownGroup[],
  manual: ClientCommitmentEntry[],
): ClientCommitment[] {
  const byClient = new Map<string, ClientCommitment>();
  for (const g of proGroups) {
    if (!g.project.startsWith("Clients/")) continue;
    // Client name is the second path segment — "Clients/<client>[/<subproject>]".
    // A client can own several burndown groups (nested subprojects); their
    // counts accumulate onto one client row.
    const name = g.project.split("/")[1] || g.project;
    const high = g.tasks.filter(
      (t) => (t.priority || "").toLowerCase() === "high",
    ).length;
    const existing = byClient.get(name);
    if (existing) {
      existing.openCount += g.count;
      existing.highCount += high;
    } else {
      byClient.set(name, {
        client: name,
        openCount: g.count,
        highCount: high,
        nextDeliverable: null,
        dueDate: null,
      });
    }
  }
  for (const m of manual) {
    if (!m.client) continue;
    const existing = byClient.get(m.client);
    if (existing) {
      existing.nextDeliverable = m.nextDeliverable;
      existing.dueDate = m.dueDate;
    } else {
      byClient.set(m.client, {
        client: m.client,
        openCount: 0,
        highCount: 0,
        nextDeliverable: m.nextDeliverable,
        dueDate: m.dueDate,
      });
    }
  }
  return [...byClient.values()].sort(
    (a, b) => b.highCount - a.highCount || b.openCount - a.openCount,
  );
}

let cache: { snapshot: DashboardSnapshot; builtAt: number } | null = null;
let inFlight: Promise<DashboardSnapshot> | null = null;
let inFlightGen = -1;
// Bumped on every invalidate so a build that started before a write is never
// cached as fresh, and post-write callers don't reuse a pre-write in-flight build.
let gen = 0;

/** Drop the cached snapshot so the next getSnapshot() rebuilds from disk. */
export function invalidate(): void {
  cache = null;
  gen++;
}

async function build(): Promise<DashboardSnapshot> {
  const generated = new Date().toISOString();

  // Clear any past-due scheduled_date back to the Work Queue once per day BEFORE
  // reading tasks, so the swept state is reflected in this very snapshot.
  await maybeSweep(localToday());

  // Burndown is the one source that throws on its own; every other reader is
  // fault-tolerant by construction, and `safe()` is a backstop for the rest.
  const [
    burndownResult,
    captures,
    shipped,
    bindings,
    tokens,
    apiSpend,
    rateLimits,
    closures,
    business,
    training,
    meals,
    nutrition,
    reviewState,
    calendar,
    tomorrow,
    clientCommitmentsRaw,
  ] = await Promise.all([
    runBurndown().then(
      (r) => ({ ok: true as const, r }),
      (err) => ({ ok: false as const, err }),
    ),
    readCaptureQueue(),
    readShippedQueue(),
    readSessionBindings(),
    safe(readTokenSpend(), { today: 0, month: 0, tokensToday: 0, tokensMonth: 0, cacheHitRate: 0, byProject: [], byModel: [], topSessions: [], avgSession: 0, sessionCount: 0, daily: [], error: "token reader failed" }, "tokens"),
    safe(readApiSpend(), EMPTY_API_SPEND, "apiSpend"),
    safe(readRateLimits(), EMPTY_RATELIMITS, "rateLimits"),
    safe(runPythonJson<ClosuresData>(CLOSURES_SCRIPT, ["--days", "14", "--format", "json"]), EMPTY_CLOSURES, "closures"),
    safe(readBusiness(), { lastUpdated: null, staleDays: null, mrr: null, activeClients: null, nextRenewal: null, claudeSubscriptionUsd: null, contracts: [], pipelineValue: null, proposalsOutstanding: null, arUnpaid: null, cac: null, ltvCacRatio: null, outreachVolume: null, error: "business reader failed" }, "business"),
    safe(readTraining(), { nextSession: null, exercises: [], restRecommended: false, lastSession: null, lastSessionDate: null, todayScheduled: false, todayComplete: false, todayTitle: null, todayId: null, todayWorkspacePath: "Internal/training-system", todayExercises: [], todaySession: [], progression: {}, error: "training reader failed" }, "training"),
    safe(readMeals(), { items: [], error: "meal reader failed" }, "meals"),
    safe(readWeight(), { todayLogged: false, latest: null, latestDate: null, sevenDayAvg: null, deltaPerWeekLb: null, window: "GAIN", state: "baseline", nudge: "", points: [], error: "weight reader failed" }, "nutrition"),
    safe(readReviewState(), { lastReviewedDate: null, lastReviewedAt: null, error: "review reader failed" }, "reviewState"),
    safe(readCalendar(), EMPTY_CALENDAR, "calendar"),
    safe(readTomorrow(), EMPTY_TOMORROW, "tomorrow"),
    readClientCommitments(),
  ]);

  if (!burndownResult.ok) {
    logger.warn({ err: burndownResult.err }, "snapshot.burndown-failed");
  }

  // burndown.py already excludes auto-generated daily ROUTINE rows (meal slots /
  // training session), so every group here is real work — the backlog/count now
  // INCLUDE meal/training PROJECT tasks (onboarding, infra) grouped by project.
  // The right-rail meal/training panels are fed separately (meal/training-reader). (2026-06-13)
  const allGroups: BurndownGroup[] = burndownResult.ok ? burndownResult.r.groups : [];
  // Tomorrow-committed work now lives in the Work Queue's "Tomorrow" tab, sourced
  // from the backlog groups directly — the Tomorrow panel is meals/training only.
  const proGroups = allGroups;
  const proTotal = proGroups.reduce((sum, g) => sum + g.count, 0);

  const backlog: DashboardSnapshot["backlog"] = burndownResult.ok
    ? { total: proTotal, projectCount: proGroups.length, groups: proGroups }
    : { total: 0, projectCount: 0, groups: [], error: String(burndownResult.err) };

  // Pull candidates — the single top task of each project group. burndown.py
  // already sorts groups largest-first and tasks priority/quick-win-first, so
  // the first task of each group is the next one to pull there.
  const pullCandidates = backlog.groups
    .filter((g) => g.tasks.length > 0)
    .map((g) => ({ project: g.project, task: g.tasks[0] }));

  // Trend — append today's point (idempotent) then return the full history.
  let trendPoints: TrendPoint[];
  let trendError: string | undefined;
  try {
    // Only record a point when burndown actually succeeded with a real backlog.
    // A failed/empty burndown would otherwise persist a spurious 0 that draws a
    // fake spike-to-zero on the trend line (and pins the y-axis floor to 0).
    if (burndownResult.ok && backlog.total > 0) {
      const perProject: Record<string, number> = {};
      for (const g of backlog.groups) perProject[g.project] = g.count;
      trendPoints = await upsertToday(backlog.total, perProject);
    } else {
      trendPoints = await readHistory();
    }
  } catch (err) {
    trendPoints = [];
    trendError = String(err);
  }

  const resolvedCount = shipped.data.filter((s) => s.resolved).length;

  // Today's movement — record the current today-plan into the manifest and
  // diff it: tasks that left the plan render as completed/moved instead of
  // silently vanishing. Fault-tolerant like every other reader.
  const todayPlan = deriveTodayPlan(allGroups, bindings.data);
  // Capacity meter: budget (from burndown, the single source) minus today's
  // meetings, minus what's already committed. Drives the Today's-plan meter and
  // the server-side pull-in gate (both read these same numbers — no second copy).
  const dailyCapacityMin = (burndownResult.ok && burndownResult.r.daily_capacity_min) || 360;
  todayPlan.dailyCapacityMin = dailyCapacityMin;
  todayPlan.availableMinutes = Math.max(0, dailyCapacityMin - (calendar.meetingMinutesToday || 0));
  todayPlan.remainingMinutes = Math.max(0, todayPlan.availableMinutes - todayPlan.committedMinutesPro);
  // Routine rows are excluded upstream (burndown), so every tracked task is real
  // work — nothing is "personal" for movement purposes. (2026-06-13)
  const movement = await safe(
    recordAndDiffToday(allGroups, () => false),
    EMPTY_MOVEMENT,
    "todayManifest",
  );
  todayPlan.completedToday = movement.completedToday;
  todayPlan.movedAway = movement.movedAway;
  // 7am morning proposal — surfaced ONLY when the pro plan is uncommitted, so it
  // replaces the empty-state alarm (never competes with a committed plan).
  const mp = await readMorningPlanState();
  if (
    mp && mp.date === localToday() && mp.status === "proposed" &&
    mp.proposedTasks.length > 0 && todayPlan.professional.length === 0
  ) {
    todayPlan.proposal = {
      tasks: mp.proposedTasks,
      warnings: mp.warnings || [],
      triageNeeded: !!mp.triageNeeded,
      overdueCount: mp.overdueCount || 0,
    };
  }

  return {
    generated,
    backlog,
    pullCandidates,
    inFlight: { items: bindings.data, error: bindings.error },
    captures: { count: captures.data.length, items: captures.data, error: captures.error },
    shipped: {
      items: shipped.data,
      resolvedCount,
      unmatchedCount: shipped.data.length - resolvedCount,
      error: shipped.error,
    },
    trend: { points: trendPoints, error: trendError },
    todayPlan,
    tokens,
    apiSpend,
    rateLimits,
    closures,
    business,
    clientCommitments: {
      items: buildClientCommitments(backlog.groups, clientCommitmentsRaw.data),
      error: clientCommitmentsRaw.error,
    },
    training,
    meals,
    nutrition,
    calendar,
    tomorrow,
    reviewState,
  };
}

/**
 * Return the dashboard snapshot, served from cache when within TTL.
 * Concurrent callers during a build share the one in-flight promise.
 */
export async function getSnapshot(): Promise<DashboardSnapshot> {
  if (cache && Date.now() - cache.builtAt < config.SNAPSHOT_TTL_MS) {
    return cache.snapshot;
  }
  // Reuse an in-flight build only if no invalidate landed since it started —
  // otherwise it read the file before the latest write and would serve stale.
  if (inFlight && inFlightGen === gen) return inFlight;
  const startGen = gen;
  inFlightGen = startGen;
  const p = build()
    .then((snapshot) => {
      // Cache only if no write invalidated us mid-build (else it's already stale).
      if (gen === startGen) cache = { snapshot, builtAt: Date.now() };
      return snapshot;
    })
    .finally(() => {
      if (inFlight === p) inFlight = null;
    });
  inFlight = p;
  return p;
}
