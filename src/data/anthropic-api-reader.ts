/**
 * Anthropic Admin API usage reader — reports direct-API spend used by agents
 * outside Claude Code. Three resolution layers:
 *   1) Admin API: GET /v1/organizations/usage_report/messages — daily buckets.
 *   2) JSON fallback: data/anthropic-api-spend.json — manually maintained.
 *   3) Unavailable: zeros + source flag for the UI to render a "pending" hint.
 *
 * USD is computed from raw token counts via the shared pricing module — the
 * Admin API returns no cost field. 1h cache to avoid hammering on every snapshot.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "../config.js";
import { logger } from "../logger.js";
import { computeUsd, modelOf } from "./pricing.js";
import type { ApiDay, ApiSpend } from "./types.js";

const FALLBACK_PATH = join(
  WORKSPACE_ROOT,
  "Internal",
  "task-dashboard",
  "data",
  "anthropic-api-spend.json",
);

const ADMIN_API_URL =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { result: ApiSpend; fetchedAt: number } | null = null;

function localDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function emptyResult(source: ApiSpend["source"], error?: string): ApiSpend {
  return { today: 0, month: 0, daily: [], source, error };
}

interface AdminBucketResult {
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens?: number;
  model?: string;
}
interface AdminBucket {
  starting_at?: string;
  results?: AdminBucketResult[];
}
interface AdminResponse {
  data?: AdminBucket[];
  has_more?: boolean;
}

/* One Admin-API page of daily cost buckets → Map<YYYY-MM-DD, costUSD>. The 1d
   bucket width caps a page at ~31 buckets, so callers fetch a month at a time. */
async function fetchDayCosts(
  key: string,
  startingAt: string,
  limit: number,
): Promise<Map<string, number> | null> {
  const url = `${ADMIN_API_URL}?starting_at=${startingAt}T00:00:00Z&bucket_width=1d&limit=${limit}&group_by[]=model`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": key, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: body.slice(0, 200) }, "anthropic-api-reader.http-error");
    return null;
  }
  const body = (await res.json()) as AdminResponse;
  const m = new Map<string, number>();
  for (const bucket of body.data || []) {
    const date = (bucket.starting_at || "").slice(0, 10);
    if (!date) continue;
    let dayCost = 0;
    for (const r of bucket.results || []) {
      const cw = r.cache_creation || {};
      dayCost += computeUsd(
        {
          input: r.uncached_input_tokens,
          output: r.output_tokens,
          cw5m: cw.ephemeral_5m_input_tokens,
          cw1h: cw.ephemeral_1h_input_tokens,
          cr: r.cache_read_input_tokens,
        },
        modelOf(r.model || ""),
      );
    }
    m.set(date, (m.get(date) || 0) + dayCost);
  }
  return m;
}

async function fetchFromAdminApi(): Promise<ApiSpend | null> {
  /* Admin API typically wants an admin-scoped key, but accept the standard
     ANTHROPIC_API_KEY as a fallback — if the owner's key has org permissions
     the same endpoint accepts it (and a 401 will demote us to fallback). */
  const key =
    process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const startingAt = localDate(new Date(Date.now() - 30 * 86_400_000));
    const cur = await fetchDayCosts(key, startingAt, 31);
    if (!cur) return emptyResult("unavailable", "admin-api error");
    const todayStr = localDate(new Date());
    const monthPrefix = todayStr.slice(0, 7);
    let today = 0;
    let month = 0;
    const daily: ApiDay[] = [...cur.entries()]
      .map(([date, costUSD]) => ({ date, costUSD }))
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const d of daily) {
      if (d.date === todayStr) today += d.costUSD;
      if (d.date.startsWith(monthPrefix)) month += d.costUSD;
    }
    // Previous calendar month — a separate page (1d buckets can't span 2 months
    // in one call). Best-effort: a failure just omits the MoM delta.
    let prevMonth: number | undefined;
    try {
      const pm = new Date();
      pm.setDate(1);
      pm.setMonth(pm.getMonth() - 1);
      const pmStart = localDate(pm);
      const pmPrefix = pmStart.slice(0, 7);
      const prev = await fetchDayCosts(key, pmStart, 31);
      if (prev) {
        let pv = 0;
        for (const [date, c] of prev) if (date.startsWith(pmPrefix)) pv += c;
        prevMonth = pv;
      }
    } catch {
      /* leave prevMonth undefined */
    }
    return { today, month, prevMonth, daily, source: "admin-api" };
  } catch (err) {
    logger.warn({ err: String(err) }, "anthropic-api-reader.admin-api-threw");
    return null;
  }
}

async function fetchFromFallback(): Promise<ApiSpend | null> {
  try {
    const raw = await readFile(FALLBACK_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { daily?: ApiDay[] };
    const daily = Array.isArray(parsed.daily) ? parsed.daily : [];
    if (!daily.length) return null;
    daily.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const todayStr = localDate(new Date());
    const monthPrefix = todayStr.slice(0, 7);
    let today = 0;
    let month = 0;
    for (const d of daily) {
      if (d.date === todayStr) today += d.costUSD || 0;
      if (d.date && d.date.startsWith(monthPrefix)) month += d.costUSD || 0;
    }
    return { today, month, daily, source: "json-fallback" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    logger.warn({ err: String(err) }, "anthropic-api-reader.fallback-threw");
    return null;
  }
}

export async function readApiSpend(): Promise<ApiSpend> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.result;
  }
  const result =
    (await fetchFromAdminApi()) ||
    (await fetchFromFallback()) ||
    emptyResult("unavailable");
  cache = { result, fetchedAt: Date.now() };
  return result;
}
