import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeaders, makeApp } from "./helpers.js";

/** Security guards on POST /action: Origin → Host → token, each fails closed. */
describe("POST /action — security guards", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const body = { kind: "task-complete", id: "T-2099-12-31-001", workspacePath: "Internal/meal-system", done: true };

  it("rejects a foreign Origin with 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders({ origin: "http://evil.example.com" }),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/origin/i);
  });

  it("rejects a foreign Host (DNS-rebinding) with 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders({ host: "attacker.example.com" }),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/host/i);
  });

  it("rejects a wrong token with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders({ "x-dashboard-token": "wrong-token" }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing token with 401", async () => {
    const headers = authHeaders();
    delete headers["x-dashboard-token"];
    const res = await app.inject({ method: "POST", url: "/action", headers, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it("passes all guards with valid Origin + Host + token (reaches validation)", async () => {
    // An unknown kind proves the request cleared every guard and hit the
    // schema layer (400), rather than a 401/403 short-circuit.
    const res = await app.inject({
      method: "POST",
      url: "/action",
      headers: authHeaders(),
      payload: { kind: "definitely-not-a-kind", done: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown action kind/i);
  });
});
