import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync } from "node:fs";
import {
  authHeaders,
  backupDatedTasks,
  backupTomorrowTasks,
  config,
  makeApp,
  todayDate,
  tomorrowDate,
} from "./helpers.js";
import { getSnapshot } from "../src/data/snapshot.js";

/** Count tomorrow-dated task files in a store dir, by slot/title substring. */
function tomorrowFiles(dir: string): Array<{ title: string; status: string }> {
  const tmr = tomorrowDate();
  const out: Array<{ title: string; status: string }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, "utf-8");
    if (!new RegExp(`scheduled_date:\\s*'?${tmr}`).test(text)) continue;
    const title = (/title:\s*(.+)/.exec(text)?.[1] || "").trim();
    const status = (/status:\s*(.+)/.exec(text)?.[1] || "").trim();
    out.push({ title, status });
  }
  return out;
}

/** Round-trip the Tomorrow lane write kinds against the real store (restored after). */
describe("POST /action — Tomorrow lane (meals-pick + training-schedule)", () => {
  let app: FastifyInstance;
  let restore: () => void;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    restore = backupTomorrowTasks();
  });
  afterEach(() => {
    restore(); // fully restore tomorrow's real meal/training store
  });

  function post(payload: unknown) {
    return app.inject({ method: "POST", url: "/action", headers: authHeaders(), payload });
  }

  it("picks a single slot without disturbing the others, and re-pick replaces in place", async () => {
    const date = tomorrowDate();
    // Clear the slot we test so the assertions are deterministic.
    const r1 = await post({ kind: "meals-pick", date, snack: "Mixed Nuts", replace: true });
    expect(r1.statusCode).toBe(200);
    let snacks = tomorrowFiles(config.MEAL_TASKS_DIR).filter((m) => m.title.startsWith("Snack"));
    expect(snacks.length).toBe(1);
    expect(snacks[0].title).toContain("Mixed Nuts");

    // Re-pick the same slot → still exactly one snack, new recipe (per-slot replace).
    const r2 = await post({ kind: "meals-pick", date, snack: "Hard-Boiled Eggs", replace: true });
    expect(r2.statusCode).toBe(200);
    snacks = tomorrowFiles(config.MEAL_TASKS_DIR).filter((m) => m.title.startsWith("Snack"));
    expect(snacks.length).toBe(1);
    expect(snacks[0].title).toContain("Hard-Boiled Eggs");
  });

  it("surfaces today's training exercise list (todayExercises from Notes)", async () => {
    const today = todayDate();
    const restoreToday = backupDatedTasks(today);
    try {
      await app.inject({
        method: "POST", url: "/action", headers: authHeaders(),
        payload: { kind: "training-schedule", date: today, session: "Upper A", replace: true },
      });
      const snap = await getSnapshot();
      expect(snap.training.todayScheduled).toBe(true);
      expect(snap.training.todayExercises.length).toBeGreaterThan(0);
      expect(snap.training.todayExercises.some((e) => e.includes("Bench Press"))).toBe(true);
    } finally {
      restoreToday();
    }
  });

  it("schedules tomorrow's training and a swap replaces it (still one task)", async () => {
    const date = tomorrowDate();
    const r1 = await post({ kind: "training-schedule", date, session: "Upper A", replace: true });
    expect(r1.statusCode).toBe(200);
    let training = tomorrowFiles(config.TRAINING_TASKS_DIR);
    expect(training.length).toBe(1);
    expect(training[0].title).toContain("Upper A");

    const r2 = await post({ kind: "training-schedule", date, session: "Lower A", replace: true });
    expect(r2.statusCode).toBe(200);
    training = tomorrowFiles(config.TRAINING_TASKS_DIR);
    expect(training.length).toBe(1);
    expect(training[0].title).toContain("Lower A");
  });

  it("a meals-pick flips snapshot.tomorrow.planned within the 4s TTL (invalidate)", async () => {
    const date = tomorrowDate();
    await post({ kind: "meals-pick", date, dessert: "Nighttime Milkshake", replace: true });
    const snap = await getSnapshot();
    expect(snap.tomorrow.planned).toBe(true);
    const sm = snap.tomorrow.meals.find((m) => m.slot === "dessert");
    expect(sm?.picked?.title).toContain("Nighttime Milkshake");
  });

  it("snapshot.tomorrow.meals carries all 5 slots incl. dessert + snack", async () => {
    const snap = await getSnapshot();
    const slots = snap.tomorrow.meals.map((m) => m.slot);
    expect(slots).toEqual(["breakfast", "lunch", "dinner", "dessert", "snack"]);
    const snack = snap.tomorrow.meals.find((m) => m.slot === "snack");
    expect((snack?.suggestions.length || 0)).toBeGreaterThan(0);
  });

  it("accepts a TODAY meals-pick (date relaxed to today)", async () => {
    const today = todayDate();
    const restoreToday = backupDatedTasks(today);
    try {
      const r = await post({ kind: "meals-pick", date: today, snack: "Mixed Nuts", replace: true });
      expect(r.statusCode).toBe(200);
      const snap = await getSnapshot();
      const picked = snap.meals.items.find((m) => m.title.startsWith("Snack"));
      expect(picked?.title).toContain("Mixed Nuts");
    } finally {
      restoreToday();
    }
  });
});
