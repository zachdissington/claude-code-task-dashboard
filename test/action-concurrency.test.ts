import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  authHeaders,
  config,
  deleteIfExists,
  makeApp,
  readFrontmatter,
  runScript,
  writeThrowawayTask,
} from "./helpers.js";

/** A dashboard write and a direct CLI write firing at once on two different
 *  tasks must both land, neither file corrupt (the per-file locks in
 *  task_helpers are what make this safe — the dashboard adds no second writer). */
describe("POST /action — concurrency with a direct CLI write", () => {
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

  it("both writers complete their own task without corrupting the other", async () => {
    const idA = "T-2099-12-31-201";
    const idB = "T-2099-12-31-202";
    const pathA = writeThrowawayTask({ id: idA, workspacePath: "Internal/training-system" });
    const pathB = writeThrowawayTask({ id: idB, workspacePath: "Internal/training-system" });
    created.push(pathA, pathB);

    const [dashRes, cliRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/action",
        headers: authHeaders(),
        payload: { kind: "task-complete", id: idA, workspacePath: "Internal/training-system", done: true },
      }),
      runScript(config.UPDATE_TASK_SCRIPT, [idB, "--complete", "--workspace-path", "Internal/training-system"]),
    ]);

    expect(dashRes.statusCode).toBe(200);
    expect(cliRes.ok).toBe(true);

    const fmA = readFrontmatter(pathA);
    const fmB = readFrontmatter(pathB);
    expect(fmA.status).toBe("complete");
    expect(fmA.id).toBe(idA);
    expect(fmB.status).toBe("complete");
    expect(fmB.id).toBe(idB);
  });
});
