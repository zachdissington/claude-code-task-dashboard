/**
 * Claude Code subscription rate-limit reader. Reports the 5-hour and 7-day
 * rolling-window utilization — the same numbers the Claude desktop app shows —
 * via the undocumented /api/oauth/usage endpoint the desktop app itself uses.
 *
 * This is NOT the Admin API (that is API-key billing; see anthropic-api-reader.ts).
 * Auth = the OAuth access token Claude Code keeps fresh in
 * ~/.claude/.credentials.json (read fresh per fetch, never persisted/logged).
 *
 * Gotchas baked in:
 *  - The User-Agent MUST start with `claude-code/` or the endpoint 429s
 *    aggressively (~30min, no Retry-After).
 *  - Must not be polled faster than ~3min — hence the >=5min own cache, kept
 *    independent of the 4s snapshot TTL.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { RateLimits, RateLimitWindow } from "./types.js";

const CACHE_TTL_MS = config.RATELIMIT_TTL_MS;
let cache: { result: RateLimits; fetchedAt: number } | null = null;

function unavailable(error?: string): RateLimits {
  return { fiveHour: null, sevenDay: null, source: "unavailable", error };
}

interface UsageWindow {
  utilization?: number;
  resets_at?: string | null;
}
interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
}

async function readToken(): Promise<string | null> {
  try {
    const raw = await readFile(config.CLAUDE_CREDENTIALS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return parsed.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function toWindow(w: UsageWindow | null | undefined): RateLimitWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  return { pct: w.utilization, resetsAt: w.resets_at ?? null };
}

async function fetchUsage(): Promise<RateLimits> {
  const token = await readToken();
  if (!token) return unavailable("no oauth token");
  try {
    const res = await fetch(config.OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": config.OAUTH_USAGE_BETA,
        "User-Agent": config.CLAUDE_CODE_UA,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "oauth-usage-reader.http-error");
      return unavailable(`oauth-usage ${res.status}`);
    }
    const body = (await res.json()) as UsageResponse;
    return {
      fiveHour: toWindow(body.five_hour),
      sevenDay: toWindow(body.seven_day),
      source: "oauth-api",
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "oauth-usage-reader.threw");
    return unavailable(String(err));
  }
}

export async function readRateLimits(): Promise<RateLimits> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.result;
  }
  const result = await fetchUsage();
  // If this attempt failed but we had a prior good read (e.g. a transient
  // 401/429 during a token refresh), keep showing last-known-good and retry
  // sooner (~60s) instead of blanking the panel for a full TTL.
  if (
    result.source === "unavailable" &&
    cache &&
    cache.result.source === "oauth-api"
  ) {
    cache = {
      result: cache.result,
      fetchedAt: Date.now() - (CACHE_TTL_MS - 60_000),
    };
    return cache.result;
  }
  cache = { result, fetchedAt: Date.now() };
  return result;
}
