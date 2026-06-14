/**
 * Meal reader — feeds the Personal view's "Today's meals" panel.
 *
 * Scans meal-system/tasks for tasks scheduled today. This is the *planned*
 * meals only — meal-system has no consumption tracking; the row's complete
 * checkbox marks the meal task done.
 */

import { config } from "../config.js";
import { readTaskDir } from "./frontmatter.js";
import type { MealsToday, MealItem } from "./types.js";

function localToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// A meal-slot routine row: explicit `routine: true` flag, or a slot-prefixed
// title. Project/operational tasks in meal-system (e.g. onboarding) are NOT
// routine — they belong on the backlog, not this panel, and must not inflate
// the meal count. (2026-06-13)
const MEAL_SLOT_RE = /^(breakfast|lunch|dinner|snack|dessert)\s*[—–-]\s/i;
function isMealRoutine(fm: Record<string, string>): boolean {
  return fm.routine === "true" || MEAL_SLOT_RE.test(fm.title || "");
}

export async function readMeals(): Promise<MealsToday> {
  const today = localToday();
  try {
    const tasks = await readTaskDir(config.MEAL_TASKS_DIR);
    const items: MealItem[] = [];
    for (const t of tasks) {
      if (t.fm.type && t.fm.type !== "task") continue;
      if ((t.fm.scheduled_date || "").slice(0, 10) !== today) continue;
      if (!isMealRoutine(t.fm)) continue;
      items.push({
        title: t.fm.title || "(untitled meal)",
        status: t.fm.status || "open",
        id: t.fm.id || "",
        workspacePath: "Internal/meal-system",
      });
    }
    // Open meals first, then completed — both alphabetical within group.
    items.sort((a, b) => {
      const ac = a.status === "complete" ? 1 : 0;
      const bc = b.status === "complete" ? 1 : 0;
      return ac - bc || a.title.localeCompare(b.title);
    });
    return { items };
  } catch (err) {
    return { items: [], error: `meal tasks unreadable: ${String(err)}` };
  }
}
