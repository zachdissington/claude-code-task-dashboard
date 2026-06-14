import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { authHeaders, config, deleteIfExists, FULL, makeApp, readFrontmatter, tomorrowDate } from "./helpers.js";

/** Round-trip the schedule-task action (commit a work task to tomorrow / clear). */
describe.skipIf(!FULL)("POST /action — schedule-task (Tomorrow's work)", () => {
  let app: FastifyInstance;
  // A throwaway work task in a real project tasks dir (sentinel id, scheduled_date null).
  const id = "T-2099-12-31-401";
  const ws = "Internal/task-dashboard";

  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
    deleteIfExists(taskPath());
  });

  function taskPath(): string {
    // Internal/task-dashboard/tasks/<id>.md, derived from the workspace root.
    return join(config.MEAL_TASKS_DIR, "..", "..", "task-dashboard", "tasks", `${id}.md`);
  }
  function seed(): void {
    const fm = [
      "---",
      "title: TEST work task — safe to delete",
      "type: task",
      "status: open",
      "priority: medium",
      `workspace_path: ${ws}`,
      "scheduled_date: null",
      "created: '2099-12-31T00:00:00Z'",
      `id: ${id}`,
      "---",
      "",
      "# TEST work task",
      "",
    ].join("\n");
    writeFileSync(taskPath(), fm, "utf-8");
  }
  function post(payload: unknown) {
    return app.inject({ method: "POST", url: "/action", headers: authHeaders(), payload });
  }

  it("commits a task to tomorrow then clears it", async () => {
    seed();
    const commit = await post({ kind: "schedule-task", id, workspacePath: ws, date: tomorrowDate() });
    expect(commit.statusCode).toBe(200);
    expect(readFrontmatter(taskPath()).scheduled_date).toBe(tomorrowDate());

    const clear = await post({ kind: "schedule-task", id, workspacePath: ws, date: "clear" });
    expect(clear.statusCode).toBe(200);
    const sd = readFrontmatter(taskPath()).scheduled_date;
    expect(sd === "null" || sd === "" || sd === undefined).toBe(true);
  });
});
