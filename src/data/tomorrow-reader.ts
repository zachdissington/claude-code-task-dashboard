/**
 * Tomorrow reader — feeds the forward "Tomorrow lane" (pick meals + training).
 *
 * Combines three sources for tomorrow (local date + 1):
 *   - existing meal/training tasks already scheduled (the picked state)
 *   - suggest_meals.py  — top-3 in-stock recipes across the 5 feeding slots
 *   - suggest_training.py — next session + rotation (for confirm/swap)
 *
 * The dashboard writes picks back through create_meal_tasks.py /
 * create_training_task.py (POST /action) — the SAME scripts /evening-review
 * uses. This reader is the read half. Fault-tolerant: a suggester error sets
 * `error` ("could not verify"), never a false "nothing planned".
 */

import { config } from "../config.js";
import { readTaskDir } from "./frontmatter.js";
import { runPythonJson } from "./python-bridge.js";
import type {
  MealSuggestion,
  TomorrowLane,
  TomorrowMealSlot,
  PickedMeal,
} from "./types.js";

const SLOTS = ["breakfast", "lunch", "dinner", "dessert", "snack"] as const;

interface SuggestMealsOutput {
  slots?: Record<string, Array<{
    name?: string;
    match_pct?: number;
    total_time?: string | null;
    needs_thaw?: boolean;
    missing?: string[];
  }>>;
  error?: string;
}
interface SuggestTrainingOutput {
  next_session?: string | null;
  rest_recommended?: boolean;
  rotation?: string[];
  error?: string;
}

function tomorrowLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** "Breakfast — Berry Smoothie" → {slot:"breakfast", recipe:"Berry Smoothie"}. */
function parseMealTitle(title: string): { slot: string; recipe: string } | null {
  const m = /^([A-Za-z]+)\s+[—-]\s+(.+)$/.exec(title.trim());
  if (!m) return null;
  return { slot: m[1].toLowerCase(), recipe: m[2].trim() };
}

export async function readTomorrow(): Promise<TomorrowLane> {
  const date = tomorrowLocal();
  const lane: TomorrowLane = {
    date,
    planned: false,
    meals: SLOTS.map((slot) => ({ slot, picked: null, suggestions: [] })),
    training: { scheduled: null, suggestion: null, restRecommended: false, rotation: [] },
    thaw: [],
  };
  const bySlot = new Map<string, TomorrowMealSlot>(lane.meals.map((m) => [m.slot, m]));

  // 1. Existing picked meal tasks for tomorrow.
  try {
    const tasks = await readTaskDir(config.MEAL_TASKS_DIR);
    for (const t of tasks) {
      if (t.fm.type && t.fm.type !== "task") continue;
      if ((t.fm.scheduled_date || "").slice(0, 10) !== date) continue;
      const parsed = parseMealTitle(t.fm.title || "");
      const slot = parsed?.slot;
      if (!slot || !bySlot.has(slot)) continue;
      const picked: PickedMeal = { id: t.fm.id || "", title: t.fm.title || "", status: t.fm.status || "open" };
      bySlot.get(slot)!.picked = picked;
      lane.planned = true;
    }
  } catch (err) {
    lane.error = `meal tasks unreadable: ${String(err)}`;
  }

  // 2. Existing training task for tomorrow.
  try {
    const tasks = await readTaskDir(config.TRAINING_TASKS_DIR);
    for (const t of tasks) {
      if (t.fm.type && t.fm.type !== "task") continue;
      if ((t.fm.scheduled_date || "").slice(0, 10) !== date) continue;
      lane.training.scheduled = { id: t.fm.id || "", title: t.fm.title || "", status: t.fm.status || "open" };
      break;
    }
  } catch {
    /* training panel still renders from the suggester */
  }

  // 3. Meal suggestions (always — so the re-pick UI has options ready).
  try {
    const s = await runPythonJson<SuggestMealsOutput>(config.SUGGEST_MEALS_SCRIPT, ["--date", date]);
    for (const slot of SLOTS) {
      const raw = s.slots?.[slot] || [];
      const suggestions: MealSuggestion[] = raw.map((r) => ({
        name: r.name || "",
        matchPct: typeof r.match_pct === "number" ? r.match_pct : 0,
        totalTime: r.total_time ?? null,
        needsThaw: Boolean(r.needs_thaw),
        missing: Array.isArray(r.missing) ? r.missing : [],
      }));
      bySlot.get(slot)!.suggestions = suggestions;
    }
  } catch (err) {
    lane.error = lane.error ? `${lane.error}; meal suggester failed` : `meal suggester failed: ${String(err)}`;
  }

  // 4. Training suggestion + rotation (for confirm/swap).
  try {
    const t = await runPythonJson<SuggestTrainingOutput>(config.SUGGEST_TRAINING_SCRIPT, ["--date", date]);
    lane.training.suggestion = t.next_session ?? null;
    lane.training.restRecommended = Boolean(t.rest_recommended);
    lane.training.rotation = Array.isArray(t.rotation) ? t.rotation : [];
  } catch {
    /* training suggestion optional */
  }

  // 5. Thaw list — picked recipes whose matching suggestion needs thawing.
  for (const m of lane.meals) {
    if (!m.picked) continue;
    const recipe = parseMealTitle(m.picked.title)?.recipe;
    if (!recipe) continue;
    const match = m.suggestions.find((s) => s.name === recipe);
    if (match?.needsThaw) lane.thaw.push(recipe);
  }

  return lane;
}
