import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  authHeaders, config, deleteIfExists, FULL, makeApp, readFrontmatter, todayDate,
} from "./helpers.js";

/**
 * Round-trip the 7am morning-proposal accept/reject actions. The proposed set is
 * read SERVER-SIDE from .tmp/morning-plan-state.json (not the client body), so we
 * seed that file + a throwaway work task and assert the accept schedules it onto
 * today. Non-destructive: a sentinel 2099 task + full backup/restore of the live
 * morning-plan state.
 */
describe.skipIf(!FULL)("POST /action — plan-accept / plan-reject (morning proposal)", () => {
  let app: FastifyInstance;
  const id = "T-2099-12-31-402";
  const ws = "Internal/task-dashboard";
  const statePath = join(config.TMP_DIR, "morning-plan-state.json");
  let restoreState: () => void;

  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    deleteIfExists(taskPath());
    restoreState();
  });

  function taskPath(): string {
    return join(config.MEAL_TASKS_DIR, "..", "..", "task-dashboard", "tasks", `${id}.md`);
  }
  function backupState(): () => void {
    const existed = existsSync(statePath);
    const original = existed ? readFileSync(statePath, "utf-8") : null;
    return () => {
      if (original === null) deleteIfExists(statePath);
      else writeFileSync(statePath, original, "utf-8");
    };
  }
  function seedTask(): void {
    const fm = [
      "---",
      "title: TEST proposed task — safe to delete",
      "type: task",
      "status: open",
      "priority: medium",
      `workspace_path: ${ws}`,
      "scheduled_date: null",
      "created: '2099-12-31T00:00:00Z'",
      `id: ${id}`,
      "---",
      "",
      "# TEST proposed task",
      "",
    ].join("\n");
    writeFileSync(taskPath(), fm, "utf-8");
  }
  function seedProposal(estMin: number): void {
    const state = {
      date: todayDate(),
      status: "proposed",
      proposedIds: [id],
      proposedTasks: [
        { id, title: "TEST proposed task", project: "Task Dashboard", priority: "medium", estMin, workBlock: null, workspacePath: ws },
      ],
      warnings: [],
      triageNeeded: false,
      overdueCount: 0,
      capacity: 360,
      generatedAt: "2099-12-31T07:00:00Z",
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  }
  function post(payload: unknown) {
    return app.inject({ method: "POST", url: "/action", headers: authHeaders(), payload });
  }

  it("accept schedules the proposed task onto today + marks state accepted", async () => {
    restoreState = backupState();
    seedTask();
    seedProposal(0); // 0-est always fits remaining capacity → deterministic

    const res = await post({ kind: "plan-accept" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; scheduled: string[]; skipped: string[] };
    expect(body.ok).toBe(true);
    expect(body.scheduled).toContain(id);
    expect(readFrontmatter(taskPath()).scheduled_date).toBe(todayDate());

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { status: string };
    expect(state.status).toBe("accepted");
  });

  it("reject marks state dismissed without scheduling anything", async () => {
    restoreState = backupState();
    seedTask();
    seedProposal(0);

    const res = await post({ kind: "plan-reject" });
    expect(res.statusCode).toBe(200);

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { status: string };
    expect(state.status).toBe("dismissed");
    const sd = readFrontmatter(taskPath()).scheduled_date;
    expect(sd === "null" || sd === "" || sd === undefined).toBe(true);
  });

  it("accept skips an over-capacity task (left unscheduled, reported skipped)", async () => {
    restoreState = backupState();
    seedTask();
    seedProposal(99999); // exceeds any day budget → skipped

    const res = await post({ kind: "plan-accept" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; scheduled: string[]; skipped: string[] };
    expect(body.scheduled).not.toContain(id);
    expect(body.skipped).toContain(id);
    const sd = readFrontmatter(taskPath()).scheduled_date;
    expect(sd === "null" || sd === "" || sd === undefined).toBe(true);
  });

  it("accept with no proposal for today is a 400", async () => {
    restoreState = backupState();
    deleteIfExists(statePath); // no state at all
    const res = await post({ kind: "plan-accept" });
    expect(res.statusCode).toBe(400);
  });

  it("reject with no proposal for today is a 400", async () => {
    restoreState = backupState();
    // A committed (non-proposed) state must not be rejectable.
    writeFileSync(statePath, JSON.stringify({
      date: todayDate(), status: "committed", proposedIds: [], proposedTasks: [],
      warnings: [], triageNeeded: false, overdueCount: 0, generatedAt: "2099-12-31T07:00:00Z",
    }), "utf-8");
    const res = await post({ kind: "plan-reject" });
    expect(res.statusCode).toBe(400);
  });
});
