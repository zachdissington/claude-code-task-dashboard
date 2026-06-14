import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeaders, makeApp } from "./helpers.js";
import { runPythonAction } from "../src/data/python-bridge.js";

/** Failure surfacing — a script error becomes a 502 the client can revert on,
 *  never a silent 200 or a hang. */
describe("POST /action — failure surfacing", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("502 with the script's stderr when the target task does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "task-complete", id: "T-2099-01-01-998", workspacePath: "Internal/training-system", done: true },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBeTruthy();
  });

  it("runPythonAction returns ok:false (not a throw) on a missing script", async () => {
    const result = await runPythonAction("C:/no/such/script-xyz.py", []);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeTruthy();
  });
});
