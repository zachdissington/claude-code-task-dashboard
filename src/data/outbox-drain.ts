/**
 * Outbox drain (Part C — offline durability).
 *
 * Pulls phone writes that landed in the always-on Cloudflare outbox Worker while
 * the PC was off, and replays each through the LOCAL `POST /action` — the same
 * validated path + canonical writers a live click uses (one writer, no drift).
 * Then acks the drained items so the Worker deletes them.
 *
 * Idempotency: every replayed clientId is recorded in `.tmp/outbox-applied.json`
 * and skipped on re-fetch, so a write that succeeded but whose ack failed is
 * never double-applied. (Most /action kinds are idempotent anyway — set-complete,
 * set-log, pick-with-replace — this is belt-and-suspenders.)
 *
 * No-op when OUTBOX_URL / OUTBOX_ADMIN_TOKEN are unset (Worker not deployed yet).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface OutboxItem {
  clientId: string;
  payload: Record<string, unknown>;
  ts?: string;
}

const APPLIED_CAP = 2000; // bound the applied-id ledger

async function loadApplied(): Promise<Set<string>> {
  try {
    const raw = await readFile(config.OUTBOX_APPLIED_PATH, "utf-8");
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveApplied(applied: Set<string>): Promise<void> {
  // Keep the most-recent APPLIED_CAP ids (insertion order ≈ recency).
  const arr = [...applied].slice(-APPLIED_CAP);
  try {
    await mkdir(dirname(config.OUTBOX_APPLIED_PATH), { recursive: true });
    await writeFile(config.OUTBOX_APPLIED_PATH, JSON.stringify(arr), "utf-8");
  } catch (err) {
    logger.warn({ err }, "outbox.applied-save-failed");
  }
}

/** Replay one queued payload through the local write endpoint. Returns
 *  "applied" (2xx, or 4xx = permanently-bad, don't retry) or "retry" (5xx/network). */
async function replay(payload: Record<string, unknown>): Promise<"applied" | "retry"> {
  const origin = config.WRITE_ORIGINS[0]; // http://localhost:<port>
  try {
    const res = await fetch(`${origin}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        host: origin.replace(/^https?:\/\//, ""),
        "x-dashboard-token": config.WRITE_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    if (res.status >= 200 && res.status < 300) return "applied";
    if (res.status >= 400 && res.status < 500) return "applied"; // bad payload — drop, never retry
    return "retry";
  } catch {
    return "retry";
  }
}

/** One drain pass. Safe to call repeatedly (boot + interval). */
export async function drainOutbox(): Promise<{ drained: number; skipped: number } | null> {
  if (!config.OUTBOX_URL || !config.OUTBOX_ADMIN_TOKEN) return null; // inert until deployed

  let items: OutboxItem[];
  try {
    const res = await fetch(`${config.OUTBOX_URL}/outbox`, {
      headers: { "x-outbox-admin": config.OUTBOX_ADMIN_TOKEN },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "outbox.list-failed");
      return null;
    }
    const body = (await res.json()) as { items?: OutboxItem[] };
    items = Array.isArray(body.items) ? body.items : [];
  } catch (err) {
    logger.warn({ err }, "outbox.list-unreachable");
    return null;
  }
  if (!items.length) return { drained: 0, skipped: 0 };

  const applied = await loadApplied();
  const ackIds: string[] = [];
  let drained = 0;
  let skipped = 0;

  for (const it of items) {
    if (!it || typeof it.clientId !== "string" || !it.payload) continue;
    if (applied.has(it.clientId)) {
      ackIds.push(it.clientId); // already applied earlier; ack to clear it
      skipped++;
      continue;
    }
    const outcome = await replay(it.payload);
    if (outcome === "applied") {
      applied.add(it.clientId);
      ackIds.push(it.clientId);
      drained++;
    }
    // "retry" → leave in the Worker, no ack, picked up next pass.
  }

  if (ackIds.length) {
    try {
      await fetch(`${config.OUTBOX_URL}/outbox/ack`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-outbox-admin": config.OUTBOX_ADMIN_TOKEN },
        body: JSON.stringify({ clientIds: ackIds }),
      });
    } catch (err) {
      logger.warn({ err }, "outbox.ack-failed"); // applied-set still guards re-apply
    }
  }
  await saveApplied(applied);
  if (drained) logger.info({ drained, skipped }, "outbox.drained");
  return { drained, skipped };
}
