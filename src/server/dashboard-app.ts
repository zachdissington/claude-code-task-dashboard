/**
 * Fastify app — the read-only task dashboard.
 *
 * Routes:
 *   GET /          — the inlined dashboard SPA
 *   GET /snapshot  — the full DashboardSnapshot JSON (all six panels)
 *   GET /health    — liveness probe for the restart script
 *   GET /events    — SSE stream of lightweight `refresh` signals
 *
 * SSE backpressure handling (the `paused`/`drain` dance, unsubscribe on close)
 * is cloned from the voice-jarvis dashboard — a slow client must never grow an
 * unbounded write queue.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { config, WORKSPACE_ROOT } from "../config.js";
import { getSnapshot, invalidate } from "../data/snapshot.js";
import { parseFrontmatter } from "../data/frontmatter.js";
import { markMorningPlanState, readMorningPlanState } from "../data/morning-plan.js";
import { runPythonAction } from "../data/python-bridge.js";
import { scheduleWritebackCommit } from "../data/writeback-committer.js";
import { logger } from "../logger.js";
import { fsEvents } from "../watcher.js";
import { DASHBOARD_HTML } from "./html.js";

/** Task fs-id shape — the only ids the write endpoint will act on. */
const TASK_ID_RE = /^T-\d{4}-\d{2}-\d{2}-\d{3}$/;

// Serialize all mutating /action work: the writers do non-atomic
// read-modify-write on shared stores (create_meal/training --replace).
// Concurrent spawns lost-update each other — rapid multi-click on a
// writable rail would collapse to a partial state.
let writeChain: Promise<void> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}
/** Only the two personal stores are writable from the board (Phase 1). */
const WRITABLE_WORKSPACES = new Set(["Internal/meal-system", "Internal/training-system"]);

/** Constant-time, constant-length token compare (SHA-256 digests). */
function tokenMatches(provided: string): boolean {
  const expected = config.WRITE_TOKEN;
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Local today / tomorrow (YYYY-MM-DD) — the dates the planning write kinds accept. */
function localDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function todayLocal(): string { return localDateOffset(0); }
function tomorrowLocal(): string { return localDateOffset(1); }
/** meals-pick / training-schedule may target today or tomorrow (TODAY is editable). */
function isPlannableDate(date: string): boolean {
  return date === todayLocal() || date === tomorrowLocal();
}
/** A safe relative in-workspace path (no traversal, no absolute) — for schedule-task. */
function isSafeWorkspacePath(p: string): boolean {
  return !!p && !p.includes("..") && !/^([a-zA-Z]:|[/\\])/.test(p);
}

const MEAL_SLOT_FLAGS: Record<string, string> = {
  breakfast: "--breakfast",
  lunch: "--lunch",
  dinner: "--dinner",
  dessert: "--dessert",
  snack: "--snack",
};

/** Validate specific created task files (the post-create gate Phase 1 deferred).
 *  Scoped to OUR files (by id) so a pre-existing bad file elsewhere can't 502 us. */
async function validateCreated(dir: string, ids: string[]): Promise<{ ok: boolean; error: string }> {
  for (const id of ids) {
    if (!id) continue;
    const r = await runPythonAction(config.VALIDATE_TASK_SCRIPT, [join(dir, `${id}.md`)]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || `validation failed for ${id}` };
  }
  return { ok: true, error: "" };
}

export async function buildDashboardApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Favicon — app-mode browser windows take their taskbar icon from it.
  // Read once at startup; a missing file is non-fatal (route just 404s).
  let iconBuf: Buffer | null = null;
  try {
    iconBuf = await readFile(config.ICON_PATH);
  } catch (err) {
    logger.warn({ err, path: config.ICON_PATH }, "favicon.unreadable");
  }

  app.get("/", async (_req, reply) => {
    // Inject the write token into the page so the client can authenticate its
    // POST /action calls. Function replacement avoids `$` being read as a
    // replacement pattern. Token lives only in .env / in-memory, never on disk here.
    const html = DASHBOARD_HTML.replace("__DASH_WRITE_TOKEN__", () => config.WRITE_TOKEN);
    reply.type("text/html").send(html);
  });

  app.get("/favicon.ico", async (_req, reply) => {
    if (!iconBuf) {
      reply.code(404).send();
      return;
    }
    reply.type("image/x-icon").header("Cache-Control", "no-cache").send(iconBuf);
  });

  // Web-app manifest — enables Add-to-Home-Screen as a full-screen app icon on
  // mobile (Part B). Standalone display; dark theme matching the dashboard.
  app.get("/manifest.webmanifest", async (_req, reply) => {
    reply.type("application/manifest+json").send({
      name: "Command Center",
      short_name: "Command",
      display: "standalone",
      orientation: "any",
      background_color: "#070b0a",
      theme_color: "#070b0a",
      start_url: "/",
      icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
    });
  });

  // Service worker (Part C — offline durability). Caches the shell so the app
  // opens when the PC/tunnel is down, and transparently re-routes a failed
  // POST /action to the always-on outbox Worker (so the phone's write survives
  // a PC-off moment). The existing write paths are unchanged — they just see a
  // 200. Outbox URL/token are baked in at serve time (the cached SW keeps them
  // when the origin is unreachable). Empty outbox config ⇒ SW only does shell
  // caching, offline writes fail as before.
  app.get("/sw.js", async (_req, reply) => {
    const sw = `
const SHELL='dashboard-shell-v1';
const OUTBOX_URL=${JSON.stringify(config.OUTBOX_URL)};
const OUTBOX_TOKEN=${JSON.stringify(config.OUTBOX_TOKEN)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(SHELL).then(c=>c.add('/')).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method==='POST'&&u.pathname==='/action'){
    e.respondWith((async()=>{
      try{return await fetch(r.clone());}
      catch(_){
        if(!OUTBOX_URL||!OUTBOX_TOKEN)return new Response(JSON.stringify({ok:false,error:'offline, outbox not configured'}),{status:503,headers:{'content-type':'application/json'}});
        try{
          const payload=await r.clone().json();
          const clientId=(self.crypto&&self.crypto.randomUUID?self.crypto.randomUUID():('c'+Date.now()+Math.floor(performance.now()))).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
          const q=await fetch(OUTBOX_URL+'/outbox',{method:'POST',headers:{'content-type':'application/json','x-outbox-token':OUTBOX_TOKEN},body:JSON.stringify({clientId,payload})});
          if(q.ok)return new Response(JSON.stringify({ok:true,queued:true}),{status:200,headers:{'content-type':'application/json'}});
          return new Response(JSON.stringify({ok:false,error:'outbox enqueue failed'}),{status:502,headers:{'content-type':'application/json'}});
        }catch(_2){return new Response(JSON.stringify({ok:false,error:'offline'}),{status:503,headers:{'content-type':'application/json'}});}
      }
    })());
    return;
  }
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).catch(()=>caches.match('/')));
    return;
  }
});`;
    reply.type("application/javascript").header("Cache-Control", "no-cache").send(sw);
  });

  app.get("/health", async () => ({
    ok: true,
    workspace: WORKSPACE_ROOT,
    port: config.PORT,
  }));

  app.get("/snapshot", async (_req, reply) => {
    const snapshot = await getSnapshot();
    reply.type("application/json").send(snapshot);
  });

  // Task detail — read a single task .md (frontmatter + Notes body) for the
  // click-to-detail overlay. Path-guarded: must resolve INSIDE the workspace
  // root and end in .md (rejects traversal). Read-only, localhost-only.
  app.get("/task", async (req, reply) => {
    const raw = String((req.query as { path?: string })?.path || "");
    const resolved = resolve(raw);
    const inWorkspace =
      resolved === WORKSPACE_ROOT || resolved.startsWith(WORKSPACE_ROOT + "\\") ||
      resolved.startsWith(WORKSPACE_ROOT + "/");
    if (!inWorkspace || !resolved.toLowerCase().endsWith(".md")) {
      reply.code(400).type("application/json").send({ error: "invalid path" });
      return;
    }
    try {
      const text = await readFile(resolved, "utf-8");
      const fm = parseFrontmatter(text);
      let body = text;
      const end = text.indexOf("\n---", 3);
      if (text.startsWith("---") && end >= 0) {
        body = text.slice(end + 4).replace(/^\s*\n/, "");
      }
      body = body.replace(/^#\s+.*\n+/, ""); // drop the leading "# Title" line
      reply.type("application/json").send({ frontmatter: fm, body });
    } catch {
      reply.code(404).type("application/json").send({ error: "task not found" });
    }
  });

  // Write-back — the ONLY mutating route. Reuses the same validated CLI writer
  // the Claude Code flow uses (update-task.py et al.) so there is one
  // writer implementation, no drift. Fails closed: no token configured ⇒ 503.
  //
  // Guard order (each fails before the next): Origin → Host → token → schema →
  // spawn. The filesystem task store stays the single source of truth; this
  // endpoint is "just another writer into the clean stores".
  app.post("/action", async (req, reply) => {
    // 1. Origin guard — a browser always sends Origin on a cross-site POST, so
    //    a present-but-foreign Origin is the CSRF / DNS-rebinding signal.
    const allowedOrigins = config.WRITE_ORIGINS as readonly string[];
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({ ok: false, error: "forbidden origin" });
    }
    // 2. Host guard — blocks DNS-rebinding (attacker hostname resolving to
    //    127.0.0.1): the Host header must be a localhost form on our port.
    const allowedHosts = allowedOrigins.map((o) => o.replace(/^https?:\/\//, ""));
    const host = req.headers.host;
    if (!host || !allowedHosts.includes(host)) {
      return reply.code(403).send({ ok: false, error: "forbidden host" });
    }
    // 3. Token guard — fail safe: disabled when unconfigured.
    if (!config.WRITE_TOKEN) {
      return reply.code(503).send({ ok: false, error: "writes disabled — set DASHBOARD_WRITE_TOKEN" });
    }
    if (!tokenMatches(String(req.headers["x-dashboard-token"] || ""))) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    // 4. Schema validation + map to an allow-listed script argv. Reject before
    //    spawning so a bad payload never reaches a subprocess.
    const body = (req.body || {}) as Record<string, unknown>;
    const NAME_MAX = 120;

    let script: string;
    let args: string[];
    // For create kinds: validate the created files afterward (the Phase-1-deferred
    // gate). { dir } where the new task files land; ids parsed from script stdout.
    let validateDir: string | null = null;

    if (body.kind === "task-complete") {
      if (typeof body.done !== "boolean") {
        return reply.code(400).send({ ok: false, error: "done must be a boolean" });
      }
      const id = String(body.id || "");
      const ws = String(body.workspacePath || "");
      if (!TASK_ID_RE.test(id)) {
        return reply.code(400).send({ ok: false, error: "invalid task id" });
      }
      if (!WRITABLE_WORKSPACES.has(ws)) {
        return reply.code(400).send({ ok: false, error: "workspacePath not writable" });
      }
      script = config.UPDATE_TASK_SCRIPT;
      args = [id, body.done ? "--complete" : "--incomplete", "--workspace-path", ws];
    } else if (body.kind === "meals-pick") {
      // Pick meals across the 5 feeding slots → create_meal_tasks.py. Today or tomorrow.
      const date = String(body.date || "");
      if (!isPlannableDate(date)) {
        return reply.code(400).send({ ok: false, error: "date must be today or tomorrow" });
      }
      args = ["--date", date];
      let slotCount = 0;
      for (const [slot, flag] of Object.entries(MEAL_SLOT_FLAGS)) {
        const v = body[slot];
        if (v === undefined || v === null || v === "") continue;
        const name = String(v);
        if (name.length > NAME_MAX) {
          return reply.code(400).send({ ok: false, error: `${slot} name too long` });
        }
        args.push(flag, name);
        slotCount++;
      }
      if (slotCount === 0) {
        return reply.code(400).send({ ok: false, error: "pick at least one slot" });
      }
      if (body.replace === true) args.push("--replace");
      script = config.CREATE_MEAL_TASKS_SCRIPT;
      validateDir = config.MEAL_TASKS_DIR;
    } else if (body.kind === "training-schedule") {
      const date = String(body.date || "");
      if (!isPlannableDate(date)) {
        return reply.code(400).send({ ok: false, error: "date must be today or tomorrow" });
      }
      const session = String(body.session || "");
      if (!session || session.length > NAME_MAX) {
        return reply.code(400).send({ ok: false, error: "invalid session" });
      }
      args = ["--date", date, "--session", session];
      if (body.replace === true) args.push("--replace");
      script = config.CREATE_TRAINING_TASK_SCRIPT;
      validateDir = config.TRAINING_TASKS_DIR;
    } else if (body.kind === "schedule-task") {
      // Commit a work task to tomorrow (or clear it) — sets scheduled_date only.
      const id = String(body.id || "");
      const ws = String(body.workspacePath || "");
      const date = String(body.date || "");
      if (!TASK_ID_RE.test(id)) {
        return reply.code(400).send({ ok: false, error: "invalid task id" });
      }
      if (!isSafeWorkspacePath(ws)) {
        return reply.code(400).send({ ok: false, error: "invalid workspacePath" });
      }
      if (date !== tomorrowLocal() && date !== "clear") {
        return reply.code(400).send({ ok: false, error: "date must be tomorrow or clear" });
      }
      args = [id, "--scheduled-date", date === "clear" ? "clear" : date, "--workspace-path", ws];
      script = config.UPDATE_TASK_SCRIPT;
    } else if (body.kind === "pull-in") {
      // Pull a work-queue task onto TODAY — gated by remaining daily capacity so
      // the board can't be re-overcommitted. Reads the same numbers the meter
      // shows (snapshot.todayPlan), then sets scheduled_date=today.
      const id = String(body.id || "");
      const ws = String(body.workspacePath || "");
      if (!TASK_ID_RE.test(id)) {
        return reply.code(400).send({ ok: false, error: "invalid task id" });
      }
      if (!isSafeWorkspacePath(ws)) {
        return reply.code(400).send({ ok: false, error: "invalid workspacePath" });
      }
      const snap = await getSnapshot();
      const remaining = snap.todayPlan.remainingMinutes;
      let est = 0;
      for (const g of snap.backlog.groups) {
        const hit = g.tasks.find((t) => t.id === id);
        if (hit) { est = hit.time_estimate || 0; break; }
      }
      if (est > remaining) {
        return reply
          .code(400)
          .send({ ok: false, error: `not enough capacity: ${remaining}m free, task needs ${est}m` });
      }
      args = [id, "--scheduled-date", todayLocal(), "--workspace-path", ws];
      script = config.UPDATE_TASK_SCRIPT;
    } else if (body.kind === "weight-log") {
      // Log the morning weigh-in → log_weight.py (the shared writer; same script
      // /plan-day and /weigh use). Appends/replaces today's row, recomputes the avg.
      const w = Number(body.weight);
      if (!Number.isFinite(w) || w < 80 || w > 400) {
        return reply.code(400).send({ ok: false, error: "weight must be 80-400 lb" });
      }
      args = ["--weight", String(w)];
      script = config.LOG_WEIGHT_SCRIPT;
    } else if (body.kind === "training-log") {
      // Progressive-overload logging — write actual loads into a task's ## Session
      // table via log_training_set.py (the one canonical body writer). T-2026-06-03-002.
      const id = String(body.id || "");
      const ws = String(body.workspacePath || "");
      const exercise = String(body.exercise || "");
      const log = String(body.log ?? "");
      if (!TASK_ID_RE.test(id)) {
        return reply.code(400).send({ ok: false, error: "invalid task id" });
      }
      if (ws !== "Internal/training-system") {
        return reply.code(400).send({ ok: false, error: "training-log only writes training-system" });
      }
      if (!exercise || exercise.length > NAME_MAX) {
        return reply.code(400).send({ ok: false, error: "invalid exercise" });
      }
      // Bounded weight×reps,reps,… shape (or empty to clear) — reject free text pre-spawn.
      if (log.length > NAME_MAX || (log.trim() !== "" && !/^\s*[\d.]+\s*[x×]\s*[\d,\s]+$/.test(log))) {
        return reply.code(400).send({ ok: false, error: "log must be 'weight×reps,reps,…' or empty" });
      }
      script = config.LOG_TRAINING_SET_SCRIPT;
      args = ["--id", id, "--exercise", exercise, "--log", log];
    } else if (body.kind === "plan-accept") {
      // Accept the 7am morning proposal: batch-schedule its tasks onto TODAY,
      // gated cumulatively by remaining capacity (the looped pull-in logic). The
      // proposed set is read SERVER-SIDE from the state file (not the client body)
      // so a stale/forged POST can't schedule arbitrary tasks. Multiple writes →
      // its own serializeWrite block (the single-script tail below handles one).
      return serializeWrite(async () => {
        const today = todayLocal();
        const state = await readMorningPlanState();
        if (!state || state.date !== today || state.status !== "proposed" || state.proposedTasks.length === 0) {
          return reply.code(400).send({ ok: false, error: "no proposal to accept" });
        }
        const snap = await getSnapshot();
        const budget = snap.todayPlan.remainingMinutes; // true free capacity today
        const scheduled: string[] = [];
        const skipped: string[] = [];
        let used = 0;
        for (const t of state.proposedTasks) {
          const est = t.estMin || 0;
          if (!TASK_ID_RE.test(t.id) || !isSafeWorkspacePath(t.workspacePath)) {
            skipped.push(t.id);
            continue;
          }
          if (used + est > budget) {
            skipped.push(t.id); // over budget — leave it in the queue
            continue;
          }
          const r = await runPythonAction(config.UPDATE_TASK_SCRIPT, [
            t.id, "--scheduled-date", today, "--workspace-path", t.workspacePath,
          ]);
          if (!r.ok) {
            logger.warn({ id: t.id, stderr: r.stderr }, "plan-accept.schedule-failed");
            skipped.push(t.id);
            continue;
          }
          scheduled.push(t.id);
          used += est;
        }
        await markMorningPlanState("accepted");
        invalidate();
        if (scheduled.length > 0) scheduleWritebackCommit();
        return reply.code(200).send({ ok: true, scheduled, skipped });
      });
    } else if (body.kind === "plan-reject") {
      // Dismiss today's proposal — the panel reverts to its normal empty state.
      // No task-store write (only the .tmp decision flips), so no auto-commit.
      return serializeWrite(async () => {
        const next = await markMorningPlanState("dismissed");
        if (!next) return reply.code(400).send({ ok: false, error: "no proposal to reject" });
        invalidate();
        return reply.code(200).send({ ok: true });
      });
    } else {
      return reply.code(400).send({ ok: false, error: "unknown action kind" });
    }

    // 5–6. Run the mutating work under the write mutex so two actions never
    //       interleave their read-modify-write (the lost-update race).
    return serializeWrite(async () => {
      // 5. Spawn the canonical writer. Non-zero exit / spawn failure → 502 with
      //    the captured stderr so the client can revert its optimistic flip.
      const result = await runPythonAction(script, args);
      if (!result.ok) {
        return reply
          .code(502)
          .send({ ok: false, error: result.stderr.trim() || "write script failed", code: result.code });
      }

      // 5b. Post-create gate — validate ONLY the files this call created (scoped by
      //     id so a pre-existing bad file elsewhere can't fail us). create scripts
      //     write schema-valid frontmatter; this is defense-in-depth.
      if (validateDir) {
        let createdIds: string[] = [];
        try {
          const out = JSON.parse(result.stdout) as { created?: Array<{ id?: string }>; status?: string; id?: string };
          if (Array.isArray(out.created)) createdIds = out.created.map((c) => c.id || "");
          else if (out.status === "created" && out.id) createdIds = [out.id];
        } catch {
          /* non-JSON stdout — nothing to validate */
        }
        const v = await validateCreated(validateDir, createdIds);
        if (!v.ok) {
          return reply.code(502).send({ ok: false, error: `created file failed validation: ${v.error}` });
        }
      }

      // 6. Drop the snapshot cache so the client's immediate re-fetch is fresh
      //    (the fs watcher SSE refresh is the backup, but it loses the 4s TTL race).
      invalidate();
      // 7. This write-back mutated the task store — schedule a debounced auto-commit
      //    so the change doesn't linger as uncommitted git noise (best-effort).
      scheduleWritebackCommit();
      return reply.code(200).send({ ok: true });
    });
  });

  // SSE — one connection per browser tab, auto-cleaned on disconnect.
  app.get("/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let paused = false;
    const onRefresh = (): void => {
      // Drop signals while the socket is backpressured — the dashboard
      // tolerates a missed tick (30s safety poll), an unbounded queue doesn't.
      if (paused) return;
      try {
        const ok = reply.raw.write("event: refresh\ndata: {}\n\n");
        if (!ok) {
          paused = true;
          reply.raw.once("drain", () => {
            paused = false;
          });
        }
      } catch {
        // Client gone; cleaned up by the close handler below.
      }
    };

    fsEvents.on("refresh", onRefresh);
    const cleanup = (): void => {
      fsEvents.off("refresh", onRefresh);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // Keep-alive ping every 25s so proxies / the browser don't drop the stream.
    const ping = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        clearInterval(ping);
      }
    }, 25_000);
    req.raw.on("close", () => clearInterval(ping));

    // Never resolve — SSE streams stay open until the client disconnects.
    await new Promise<void>((resolve) => req.raw.on("close", resolve));
  });

  logger.info("dashboard-app.built");
  return app;
}
