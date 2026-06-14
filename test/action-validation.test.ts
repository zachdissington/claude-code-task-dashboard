import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeaders, makeApp, tomorrowDate } from "./helpers.js";

/** Input validation — every bad payload is rejected (400) BEFORE any spawn. */
describe("POST /action — input validation", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function post(payload: unknown) {
    return app.inject({ method: "POST", url: "/action", headers: authHeaders(), payload });
  }

  it("400 on a non-boolean done", async () => {
    const res = await post({ kind: "task-complete", id: "T-2099-12-31-001", workspacePath: "Internal/meal-system", done: "yes" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/boolean/i);
  });

  it("400 on a malformed task id", async () => {
    const res = await post({ kind: "task-complete", id: "not-an-id", workspacePath: "Internal/meal-system", done: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/id/i);
  });

  it("400 on a workspacePath outside the writable allow-list", async () => {
    const res = await post({ kind: "task-complete", id: "T-2099-12-31-001", workspacePath: "Clients/client-alpha", done: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/workspace/i);
  });

  it("400 on an unknown action kind", async () => {
    const res = await post({ kind: "delete-everything", done: true });
    expect(res.statusCode).toBe(400);
  });

  it("400 on meals-pick with a non-tomorrow date", async () => {
    const res = await post({ kind: "meals-pick", date: "2099-12-31", breakfast: "X" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tomorrow/i);
  });

  it("400 on training-schedule with a non-tomorrow date", async () => {
    const res = await post({ kind: "training-schedule", date: "2099-12-31", session: "Upper A" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tomorrow/i);
  });

  it("400 on meals-pick with zero slots (valid date)", async () => {
    const res = await post({ kind: "meals-pick", date: tomorrowDate() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one slot/i);
  });

  it("400 on training-schedule with an empty session (valid date)", async () => {
    const res = await post({ kind: "training-schedule", date: tomorrowDate(), session: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/session/i);
  });

  it("400 on schedule-task with a malformed id", async () => {
    const res = await post({ kind: "schedule-task", id: "nope", workspacePath: "Internal/x", date: tomorrowDate() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/id/i);
  });

  it("400 on schedule-task with a traversal workspacePath", async () => {
    const res = await post({ kind: "schedule-task", id: "T-2099-12-31-001", workspacePath: "../etc", date: tomorrowDate() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/workspace/i);
  });

  it("400 on schedule-task with a non-{tomorrow,clear} date", async () => {
    const res = await post({ kind: "schedule-task", id: "T-2099-12-31-001", workspacePath: "Internal/x", date: "2099-01-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tomorrow or clear/i);
  });
});
