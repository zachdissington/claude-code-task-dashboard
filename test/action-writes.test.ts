import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import {
  authHeaders,
  config,
  deleteIfExists,
  makeApp,
  readFrontmatter,
  writeThrowawayTask,
  FULL,
} from "./helpers.js";
import { getSnapshot } from "../src/data/snapshot.js";

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Round-trip writes through the REAL update-task.py writer. */
describe.skipIf(!FULL)("POST /action — round-trip writes", () => {
  let app: FastifyInstance;
  const created: string[] = [];
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    for (const p of created.splice(0)) deleteIfExists(p);
  });

  function post(payload: unknown) {
    return app.inject({ method: "POST", url: "/action", headers: authHeaders(), payload });
  }

  it("completes then re-opens a training task (status + last_completed round-trip)", async () => {
    const id = "T-2099-12-31-101";
    const path = writeThrowawayTask({ id, workspacePath: "Internal/training-system" });
    created.push(path);

    const done = await post({ kind: "task-complete", id, workspacePath: "Internal/training-system", done: true });
    expect(done.statusCode).toBe(200);
    let fm = readFrontmatter(path);
    expect(fm.status).toBe("complete");
    expect(fm.last_completed).toBeTruthy();
    expect(fm.last_completed).not.toBe("null");

    const undo = await post({ kind: "task-complete", id, workspacePath: "Internal/training-system", done: false });
    expect(undo.statusCode).toBe(200);
    fm = readFrontmatter(path);
    expect(fm.status).toBe("open");
  });

  it("completes a meal task", async () => {
    const id = "T-2099-12-31-102";
    const path = writeThrowawayTask({ id, workspacePath: "Internal/meal-system" });
    created.push(path);
    const res = await post({ kind: "task-complete", id, workspacePath: "Internal/meal-system", done: true });
    expect(res.statusCode).toBe(200);
    expect(readFrontmatter(path).status).toBe("complete");
  });

  it("is idempotent — completing an already-complete task stays complete", async () => {
    const id = "T-2099-12-31-103";
    const path = writeThrowawayTask({ id, workspacePath: "Internal/training-system" });
    created.push(path);
    await post({ kind: "task-complete", id, workspacePath: "Internal/training-system", done: true });
    const again = await post({ kind: "task-complete", id, workspacePath: "Internal/training-system", done: true });
    expect(again.statusCode).toBe(200);
    expect(readFrontmatter(path).status).toBe("complete");
  });

  it("invalidates the snapshot cache — a completed meal shows fresh inside the 4s TTL", async () => {
    // A today-dated throwaway meal appears in snapshot.meals.items by id.
    // Title must be slot-prefixed: the meal panel now renders only ROUTINE rows
    // (meal slots / training session), not arbitrary meal-system tasks. (2026-06-13)
    const id = `T-${localToday()}-990`;
    const dir = config.MEAL_TASKS_DIR;
    const path = join(dir, `${id}.md`);
    deleteIfExists(path);
    writeThrowawayTask({ id, workspacePath: "Internal/meal-system", title: "Lunch — TEST throwaway (safe to delete)" });
    // Re-stamp scheduled_date to today so the meal reader surfaces it.
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(path, readFileSync(path, "utf-8").replace("scheduled_date: null", `scheduled_date: '${localToday()}'`), "utf-8");
    created.push(path);

    const before = await getSnapshot(); // warm the cache
    const ours = before.meals.items.find((m) => m.id === id);
    expect(ours?.status).toBe("open");

    const res = await post({ kind: "task-complete", id, workspacePath: "Internal/meal-system", done: true });
    expect(res.statusCode).toBe(200);

    const after = await getSnapshot(); // would be stale (open) if invalidate() didn't fire
    expect(after.meals.items.find((m) => m.id === id)?.status).toBe("complete");
  });

});
