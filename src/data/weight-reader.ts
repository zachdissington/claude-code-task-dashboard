/**
 * Weight reader — feeds the right-rail Nutrition panel (weigh-in control loop).
 *
 * Shells out to log_weight.py --status --json rather than re-parsing
 * weight-log.md in TypeScript, so the 7-day average + adjustment nudge are
 * computed in ONE place (the same script /plan-day and /weigh use) — no drift.
 */

import { config } from "../config.js";
import { runPythonJson } from "./python-bridge.js";
import type { NutritionStatus, WeightPoint } from "./types.js";

interface StatusJson {
  today_logged?: boolean;
  latest?: number | null;
  latest_date?: string | null;
  seven_day_avg?: number | null;
  delta_per_week_lb?: number | null;
  window?: string;
  state?: string;
  nudge?: string;
  points?: WeightPoint[];
  error?: string;
}

export async function readWeight(): Promise<NutritionStatus> {
  try {
    const s = await runPythonJson<StatusJson>(config.LOG_WEIGHT_SCRIPT, ["--status", "--json"]);
    return {
      todayLogged: Boolean(s.today_logged),
      latest: s.latest ?? null,
      latestDate: s.latest_date ?? null,
      sevenDayAvg: s.seven_day_avg ?? null,
      deltaPerWeekLb: s.delta_per_week_lb ?? null,
      window: s.window || "GAIN",
      state: s.state || "baseline",
      nudge: s.nudge || "",
      points: Array.isArray(s.points) ? s.points : [],
    };
  } catch (err) {
    return {
      todayLogged: false,
      latest: null,
      latestDate: null,
      sevenDayAvg: null,
      deltaPerWeekLb: null,
      window: "GAIN",
      state: "baseline",
      nudge: "",
      points: [],
      error: `log_weight.py --status failed: ${String(err)}`,
    };
  }
}
