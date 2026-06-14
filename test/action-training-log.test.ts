/**
 * training-log action — progressive-overload logging into a task's ## Session
 * table (T-2026-06-03-002). Round-trips through the REAL log_training_set.py
 * writer against a throwaway 2099 task (scheduled_date:null, never in any panel).
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { authHeaders, config, deleteIfExists, makeApp } from "./helpers.js";

const ID = "T-2099-12-31-941";
const PATH = join(config.TRAINING_TASKS_DIR, `${ID}.md`);

function writeLiftTask(): void {
  const body = [
    "---",
    "title: TEST lift throwaway — safe to delete",
    "type: task",
    "status: open",
    "priority: low",
    "workspace_path: Internal/training-system",
    "scheduled_date: null",
    "created: '2099-12-31T00:00:00Z'",
    "last_completed: null",
    `id: ${ID}`,
    "---",
    "",
    "# TEST lift throwaway",
    "",
    "## Session",
    "",
    "| Exercise | Target | Last | Log |",
    "|---|---|---|---|",
    "| Bench Press | 4x3-6 @ 1-3 RIR | — |  |",
    "| Back Squat | 4x3-6 @ 1-3 RIR | — |  |",
    "",
  ].join("\n");
  writeFileSync(PATH, body, "utf-8");
}

describe("training-log action", () => {
  afterEach(() => deleteIfExists(PATH));

  it("writes a set into the matching ## Session Log cell", async () => {
    writeLiftTask();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "training-log", id: ID, workspacePath: "Internal/training-system", exercise: "Bench Press", log: "185x5,5,4,4" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const text = readFileSync(PATH, "utf-8");
    expect(text).toMatch(/\| Bench Press \| 4x3-6 @ 1-3 RIR \| — \| 185x5,5,4,4 \|/);
    // The other row is untouched.
    expect(text).toMatch(/\| Back Squat \| 4x3-6 @ 1-3 RIR \| — \|\s*\|/);
  });

  it("rejects a free-text log before spawning (400)", async () => {
    writeLiftTask();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "training-log", id: ID, workspacePath: "Internal/training-system", exercise: "Bench Press", log: "felt heavy" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-training workspace (400)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "training-log", id: ID, workspacePath: "Internal/meal-system", exercise: "Bench Press", log: "100x5" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("surfaces an unknown exercise as a writer failure (502)", async () => {
    writeLiftTask();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "training-log", id: ID, workspacePath: "Internal/training-system", exercise: "Nonexistent Lift", log: "100x5" },
    });
    await app.close();
    expect(res.statusCode).toBe(502);
  });
});
