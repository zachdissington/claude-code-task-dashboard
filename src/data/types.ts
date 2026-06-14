/** Shared shapes for the dashboard snapshot. */

/** A task as emitted by burndown.py --format json. */
export interface BurndownTask {
  id: string;
  title: string;
  priority: string; // "high" | "medium" | "low" | "" — IMPORTANCE only (not readiness)
  project: string;
  // Umbrella grouping from project_groups.py (single source of truth). The
  // dashboard groups the backlog + work queue by `group`; the ranker ranks
  // tasks within it. Many raw projects can share one group (Internal Tools).
  group?: string;
  group_display?: string;
  group_klass?: string; // client | internal | skill | personal | root
  time_estimate: number;
  fs_path: string;
  scheduled_date: string | null; // YYYY-MM-DD or null
  scheduled_at?: string | null; // ISO: when it landed on scheduled_date (plan tiebreak; oldest-committed wins)
  created?: string | null; // ISO creation stamp; the age-tiebreak fallback when scheduled_at is absent
  work_block: string | null; // morning | afternoon | evening | anytime | null
  blocked_by?: string | null; // what we're waiting on (client, insurance, a task id); null/absent = actionable
  waiting_on?: string | null; // Phase-2 typed readiness: free-text external condition (parks the task)
  depends_on?: string[] | null; // Phase-2 typed readiness: task-id list (parks until all resolved)
  blocked_since?: string | null; // YYYY-MM-DD of last logged activity (newest Notes stamp / mtime)
  rank?: number | null; // LLM "do-this-first" order within the group; null until computed
  rank_reason?: string | null; // one-line why for the group's #1
}

/**
 * A task that was on today's plan earlier in the day and has since left it —
 * either completed (gone from the open-task set) or rescheduled to a future
 * date. Sourced from data/today-plan-manifest.json (today-manifest.ts) so the
 * Today's plan panel shows what happened instead of a silent disappearance.
 */
export interface TodayMovementItem {
  title: string;
  project: string;
  fs_path: string;
  priority: string;
  work_block: string | null;
  time_estimate: number;
  /** movedAway only: the new scheduled_date (YYYY-MM-DD), or null if unscheduled. */
  newDate?: string | null;
}

/** The committed daily plan — tasks scheduled for today, split by view. */
export interface TodayPlan {
  professional: BurndownTask[];
  personal: BurndownTask[];
  committedMinutesPro: number;
  committedMinutesPersonal: number;
  overduePro: number; // scheduled before today, still open
  overduePersonal: number;
  /** Daily task-work budget (minutes) — DAILY_CAPACITY_MIN, via burndown.py. */
  dailyCapacityMin: number;
  /** Budget left after meetings: dailyCapacityMin − meetingMinutesToday. */
  availableMinutes: number;
  /** What's still free today: availableMinutes − committedMinutesPro (≥0). */
  remainingMinutes: number;
  /** Professional tasks that were on today's plan and are now closed. */
  completedToday: TodayMovementItem[];
  /** Professional tasks that were on today's plan and got rescheduled to a future date. */
  movedAway: TodayMovementItem[];
  /** The 7am auto-proposed plan, surfaced ONLY when the pro plan is uncommitted
   *  (the empty-state morning fallback). Absent/null otherwise. (T-2026-05-29-001) */
  proposal?: MorningPlanProposal | null;
}

/** One proposed task in the morning auto-plan (a work-queue pull candidate). */
export interface MorningPlanProposalTask {
  id: string;
  title: string;
  project: string;
  priority: string;
  estMin: number;
  workBlock: string | null;
  /** The schedule-task write target (relative workspace path). */
  workspacePath: string;
}

/** The morning auto-plan proposal as the snapshot surfaces it to Today's plan. */
export interface MorningPlanProposal {
  tasks: MorningPlanProposalTask[];
  /** plan-day warnings + a synthesized "N overdue need triage" nudge when relevant. */
  warnings: string[];
  triageNeeded: boolean;
  overdueCount: number;
}

/**
 * Persisted morning-plan state (.tmp/morning-plan-state.json) — the 7am job's
 * output + the user's accept/reject decision for the day. Date-keyed so a stale
 * proposal never resurfaces; self-resets when the date rolls.
 */
export interface MorningPlanState {
  date: string; // YYYY-MM-DD the proposal/decision is for
  /** proposed = awaiting decision; accepted/dismissed = user acted; committed =
   *  the day already had a plan at fire time (no proposal); empty = nothing to pull. */
  status: "proposed" | "accepted" | "dismissed" | "committed" | "empty";
  proposedIds: string[];
  proposedTasks: MorningPlanProposalTask[];
  warnings: string[];
  triageNeeded: boolean;
  overdueCount: number;
  /** Day budget (minutes) the proposal was sized against — DAILY_CAPACITY minus meetings. */
  capacity?: number;
  generatedAt: string;
}

/** A project group as emitted by burndown.py --format json. */
export interface BurndownGroup {
  project: string;
  count: number;
  minutes: number;
  tasks: BurndownTask[];
}

/** Raw burndown.py --format json payload. */
export interface BurndownResult {
  generated: string;
  total: number;
  /** Daily task-work budget in minutes (DAILY_CAPACITY_MIN); the single source. */
  daily_capacity_min?: number;
  groups: BurndownGroup[];
}

/** A session binding record (.tmp/session_bindings/<id>.json). */
export interface BindingRecord {
  session_id: string;
  task_id: string;
  task_fs_path: string;
  task_fs_id: string;
  task_title: string;
  client_id: string | null;
  workspace_path: string;
  bound_at: string;
}

/** A shipped-work record (.tmp/shipped_queue.json). */
export interface ShippedItem {
  id: string;
  shipped_at: string;
  title_hint: string;
  summary: string;
  resolved: boolean;
}

/** A pending capture-queue item (.tmp/capture_queue.json). Shape is loose. */
export interface CaptureItem {
  text: string;
  source_context?: string;
  suggested_destination?: string;
  suggested_priority?: string;
}

/** One day's backlog snapshot in the trend history. */
export interface TrendPoint {
  date: string; // YYYY-MM-DD
  total: number;
  per_project: Record<string, number>;
}

/* ---------------------------------------------------------------- *
 *  Personal / Life view
 * ---------------------------------------------------------------- */

/** One structured lift-session row, parsed from the task's `## Session` table
 *  (training-system session_model). Endurance days have none. (T-2026-05-31-002) */
export interface TrainingExercise {
  exercise: string;
  target: string;
  /** Prior logged top-set loads (the progression anchor), or "" when none. */
  last: string;
  /** Actual logged loads `weight×reps,…`, "" until filled. */
  log: string;
}

/** A per-exercise double-progression hint from suggest_training.py. */
export interface ProgressionHint {
  last: string | null;
  suggestion: string;
}

/** Today's training session (from training-system/suggest_training.py). */
export interface TrainingToday {
  /** Next session in the Upper/Lower rotation, or null when a rest is advised. */
  nextSession: string | null;
  exercises: string[];
  restRecommended: boolean;
  lastSession: string | null;
  lastSessionDate: string | null;
  /** A training task scheduled for today exists in the store. */
  todayScheduled: boolean;
  /** That task's status is complete. */
  todayComplete: boolean;
  todayTitle: string | null;
  /** fs id (T-...) of today's training task — the write-back target. null when none. */
  todayId: string | null;
  /** workspace_path for the write-back (always Internal/training-system here). */
  todayWorkspacePath: string;
  /** Today's task's exercise list (sets/reps/distances) from its ## Notes body. */
  todayExercises: string[];
  /** Structured lift rows from the task's `## Session` table — [] on endurance
   *  days / legacy tasks. The progressive-overload logging surface. */
  todaySession: TrainingExercise[];
  /** Per-exercise double-progression hint (keyed by exercise) from the suggester. */
  progression: Record<string, ProgressionHint>;
  error?: string;
}

/** A meal task scheduled for today (from meal-system/tasks). */
export interface MealItem {
  title: string;
  status: string; // open | complete | ...
  /** fs id (T-...) — the write-back target for ticking the meal done/undone. */
  id: string;
  /** workspace_path for the write-back (always Internal/meal-system here). */
  workspacePath: string;
}
export interface MealsToday {
  items: MealItem[];
  error?: string;
}

/** Weigh-in control loop status (from log_weight.py --status --json). */
export interface WeightPoint {
  date: string;
  lb: number;
}
export interface NutritionStatus {
  todayLogged: boolean;
  latest: number | null;
  latestDate: string | null;
  sevenDayAvg: number | null;
  deltaPerWeekLb: number | null;
  window: string; // GAIN | MAINTENANCE
  state: string; // baseline | under | on_track | over — drives the panel color
  nudge: string;
  points: WeightPoint[];
  error?: string;
}

/* ---- Tomorrow lane (forward planning: pick meals + schedule training) ---- */

/** One inventory-ranked recipe suggestion for a slot (from suggest_meals.py). */
export interface MealSuggestion {
  name: string;
  matchPct: number; // 0..1
  totalTime: string | null;
  needsThaw: boolean;
  missing: string[];
}
/** A task already picked for a tomorrow slot. */
export interface PickedMeal {
  id: string;
  title: string;
  status: string;
}
/** One of the 5 feeding slots for tomorrow: a pick (if planned) + suggestions. */
export interface TomorrowMealSlot {
  slot: string; // breakfast | lunch | dinner | snack | smoothie
  picked: PickedMeal | null;
  suggestions: MealSuggestion[];
}
/** Tomorrow's training: an existing scheduled task, plus the rotation suggestion. */
export interface TomorrowTraining {
  scheduled: { id: string; title: string; status: string } | null;
  suggestion: string | null; // next_session from suggest_training (null if rest)
  restRecommended: boolean;
  rotation: string[]; // full session list — drives the swap control
}
/** A work task surfaced in the Tomorrow "Work" block. */
export interface TomorrowWorkItem {
  id: string;
  title: string;
  project: string; // workspace_path — the schedule-task write target
  priority: string;
  /** time_estimate minutes (0 when unset) — sizes the pull decision. */
  estMin: number;
}
/** The forward Tomorrow lane — pick meals + confirm/swap training on the board. */
export interface TomorrowLane {
  date: string; // YYYY-MM-DD (tomorrow, local)
  planned: boolean; // any meal task already scheduled for tomorrow
  meals: TomorrowMealSlot[]; // the 5 feedings, in order
  training: TomorrowTraining;
  thaw: string[]; // recipe names among the picks that need thawing tonight
  /** Work tasks: committed (scheduled for tomorrow) + proposed pulls (unscheduled). */
  work?: { committed: TomorrowWorkItem[]; proposed: TomorrowWorkItem[] };
  error?: string;
}

/** A Google Calendar event (from calendar-read-window.py — live pull). */
export interface CalendarEvent {
  title: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day events
  end: string;
  date: string; // YYYY-MM-DD
  isToday: boolean;
  allDay: boolean;
  durationMins: number | null; // null for all-day events
  meetLink: string | null;
}
/** Today's meetings + the 5-day prep horizon. */
export interface CalendarToday {
  today: CalendarEvent[];
  prepHorizon: CalendarEvent[];
  /** Sum of timed meeting minutes today — capacity math, all-day excluded. */
  meetingMinutesToday: number;
  error?: string;
}

/* ---------------------------------------------------------------- *
 *  Professional view — token spend + business KPIs
 * ---------------------------------------------------------------- */

/** Per-model cost + token share. */
export interface TokenModelSplit {
  model: string; // "opus" | "sonnet" | "haiku"
  costUSD: number;
  tokens: number;
}

/** A single Claude Code session's cost (one transcript file = one session). */
export interface TokenSession {
  session: string; // session id (transcript filename, no extension)
  project: string;
  costUSD: number;
}

/**
 * Claude Code usage, derived from ~/.claude/projects/*.jsonl.
 * USD figures are LIST-PRICE value (tokens x per-model rate) — on a Claude Max
 * subscription this is value consumed, not money billed.
 */
export interface TokenSpend {
  today: number; // list-price USD today
  month: number; // list-price USD this month
  tokensToday: number; // total tokens today (all types)
  tokensMonth: number; // total tokens this month
  cacheHitRate: number; // 0..1 — share of prompt tokens served from cache, this month
  byProject: Array<{ project: string; costUSD: number }>;
  byModel: TokenModelSplit[];
  topSessions: TokenSession[]; // most expensive sessions this month
  avgSession: number; // mean cost per session this month
  sessionCount: number;
  /** Trailing 91 days of daily cost, oldest-first — feeds the heatmap. */
  daily: Array<{ date: string; costUSD: number }>;
  error?: string;
}

/** One day's API spend (Admin API or manual JSON). */
export interface ApiDay {
  date: string; // YYYY-MM-DD
  costUSD: number;
}

/** Anthropic API direct-use spend — Admin API or manual JSON fallback. */
export interface ApiSpend {
  today: number;
  month: number;
  /** Previous calendar month total — drives the MoM delta on the Expenses KPI. */
  prevMonth?: number;
  /** Trailing ~60 days, oldest-first. */
  daily: ApiDay[];
  source: "admin-api" | "json-fallback" | "unavailable";
  error?: string;
}

/** One rolling rate-limit window (5h or 7d) from /api/oauth/usage. */
export interface RateLimitWindow {
  /** Utilization 0-100. */
  pct: number;
  /** ISO timestamp when the window resets, or null. */
  resetsAt: string | null;
}
/** Claude Code subscription rate-limit windows (NOT API-key billing). */
export interface RateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  source: "oauth-api" | "unavailable";
  error?: string;
}

/** One day's closure count for the bar chart. */
export interface ClosureDay {
  date: string;
  count: number;
}

/** A recently-closed task surfaced in the Closures panel. */
export interface ClosureRecent {
  title: string;
  project: string;
  closedAt: string;
}

/** Closed-task count per project over the window (drives the by-project bars). */
export interface ClosureProject {
  project: string;
  count: number;
}

/**
 * Closed tasks in the trailing window — drives the Closures panel that
 * replaced Shipped Velocity. Counts tasks with status:complete + last_completed
 * inside the window; derived from the task store, not /ship invocations.
 */
export interface ClosuresData {
  windowDays: number;
  total: number;
  daily: ClosureDay[];
  recent: ClosureRecent[];
  byProject?: ClosureProject[];
  /** Every closure in the window — feeds the bar/project drill-down overlays. */
  all?: Array<{ id: string; title: string; project: string; closedDate: string }>;
  error?: string;
}

/** A client contract line in the manual business-metrics file. */
export interface ContractLine {
  client: string;
  /** Monthly recurring value — summed over active contracts to derive MRR. */
  monthlyValue: number;
  status: string; // "active" | "paused" | "ended" | ...
  /** YYYY-MM-DD or null — earliest future one derives `nextRenewal`. */
  renewalDate: string | null;
}

/**
 * Business KPIs. `mrr` / `activeClients` / `nextRenewal` are DERIVED from the
 * `contracts` array; the three scalars are hand-entered; the deferred trio
 * stays null until Stripe/Instantly wiring lands (Phase 3) and renders as one
 * collapsed line.
 */
export interface BusinessMetrics {
  lastUpdated: string | null;
  /** Days since lastUpdated; null when unknown. */
  staleDays: number | null;
  /** Derived: sum of `monthlyValue` over active contracts (null if no contracts). */
  mrr: number | null;
  /** Derived: count of active contracts (null if no contracts). */
  activeClients: number | null;
  /** Derived: earliest future renewal among active contracts. */
  nextRenewal: { client: string; date: string } | null;
  /** Monthly Claude subscription cost — drives the token-panel leverage ratio. */
  claudeSubscriptionUsd: number | null;
  contracts: ContractLine[];
  /** Hand-entered scalars — refreshed weekly via Claude Code. */
  pipelineValue: number | null;
  proposalsOutstanding: number | null;
  arUnpaid: number | null;
  /** Deferred KPIs — null until Stripe/Instantly wiring lands (Phase 3). */
  cac: number | null;
  ltvCacRatio: number | null;
  outreachVolume: number | null;
  error?: string;
}

/**
 * One client's commitment row — auto open/high counts from the burndown client
 * groups, merged with the optional manual `client-commitments.json` layer.
 */
export interface ClientCommitment {
  client: string;
  openCount: number;
  highCount: number;
  nextDeliverable: string | null;
  dueDate: string | null;
}

/** The full payload served at GET /snapshot. */
export interface DashboardSnapshot {
  generated: string;
  backlog: {
    total: number;
    projectCount: number;
    groups: BurndownGroup[];
    error?: string;
  };
  pullCandidates: Array<{ project: string; task: BurndownTask }>;
  inFlight: { items: BindingRecord[]; error?: string };
  captures: { count: number; items: CaptureItem[]; error?: string };
  shipped: {
    items: ShippedItem[];
    resolvedCount: number;
    unmatchedCount: number;
    error?: string;
  };
  trend: { points: TrendPoint[]; error?: string };
  todayPlan: TodayPlan;
  // Professional-view additions
  tokens: TokenSpend;
  apiSpend: ApiSpend;
  rateLimits: RateLimits;
  closures: ClosuresData;
  business: BusinessMetrics;
  clientCommitments: { items: ClientCommitment[]; error?: string };
  // Personal-view additions
  training: TrainingToday;
  meals: MealsToday;
  nutrition: NutritionStatus;
  // Right-rail calendar (live Google Calendar pull)
  calendar: CalendarToday;
  // Forward planning — pick tomorrow's meals + training on the board
  tomorrow: TomorrowLane;
  // Evening-review freshness — drives the "last reviewed" line + stale nudge
  reviewState: ReviewState;
}

/** Evening-review freshness stamp (from .tmp/review-state.json). */
export interface ReviewState {
  /** Local date (YYYY-MM-DD) the review last ran, or null if never. */
  lastReviewedDate: string | null;
  /** ISO8601 UTC timestamp of the last review, or null if never. */
  lastReviewedAt: string | null;
  error?: string;
}
