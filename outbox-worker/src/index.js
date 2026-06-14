/**
 * Dashboard outbox Worker (Part C — offline durability).
 *
 * An always-on durable inbox so a phone write made while the PC is OFF survives
 * and the PC drains it on boot. The filesystem task store stays the single
 * source of truth — this is a transient write-ahead queue, never read as state.
 *
 * Routes (all JSON):
 *   POST /outbox      — phone appends a queued /action payload. Auth: X-Outbox-Token
 *                       (in the page; same trust level as the dashboard write token).
 *   GET  /outbox      — PC fetches pending items. Auth: X-Outbox-Admin (PC-only).
 *   POST /outbox/ack  — PC clears drained clientIds. Auth: X-Outbox-Admin.
 *
 * Storage: KV namespace OUTBOX_KV, one key per item (`item:<clientId>`), TTL 7d
 * so an undrained item can't accumulate forever.
 */

const ITEM_PREFIX = "item:";
const ITEM_TTL_S = 7 * 24 * 3600;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Constant-time-ish compare (Workers have no timingSafeEqual; length+char fold).
function tokenOk(provided, expected) {
  if (!expected || !provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // --- phone enqueue ---
    if (url.pathname === "/outbox" && method === "POST") {
      if (!tokenOk(request.headers.get("x-outbox-token") || "", env.OUTBOX_TOKEN)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      const clientId = String(body.clientId || "");
      const payload = body.payload;
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId) || !payload || typeof payload !== "object") {
        return json({ ok: false, error: "clientId + payload required" }, 400);
      }
      const item = { clientId, payload, ts: body.ts || new Date().toISOString() };
      // Idempotent enqueue: same clientId overwrites (a retried POST is harmless).
      await env.OUTBOX_KV.put(ITEM_PREFIX + clientId, JSON.stringify(item), { expirationTtl: ITEM_TTL_S });
      return json({ ok: true });
    }

    // --- PC drain: list pending ---
    if (url.pathname === "/outbox" && method === "GET") {
      if (!tokenOk(request.headers.get("x-outbox-admin") || "", env.OUTBOX_ADMIN_TOKEN)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const list = await env.OUTBOX_KV.list({ prefix: ITEM_PREFIX, limit: 1000 });
      const items = [];
      for (const k of list.keys) {
        const v = await env.OUTBOX_KV.get(k.name);
        if (v) items.push(JSON.parse(v));
      }
      return json({ ok: true, items });
    }

    // --- PC drain: ack (delete) drained items ---
    if (url.pathname === "/outbox/ack" && method === "POST") {
      if (!tokenOk(request.headers.get("x-outbox-admin") || "", env.OUTBOX_ADMIN_TOKEN)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      const ids = Array.isArray(body.clientIds) ? body.clientIds : [];
      let deleted = 0;
      for (const id of ids) {
        if (/^[A-Za-z0-9_-]{8,64}$/.test(String(id))) {
          await env.OUTBOX_KV.delete(ITEM_PREFIX + id);
          deleted++;
        }
      }
      return json({ ok: true, deleted });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
