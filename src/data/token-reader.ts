/**
 * Token-usage reader — scans Claude Code session transcripts.
 *
 * Claude Code writes one JSONL file per session under
 * ~/.claude/projects/<slug>/<session-id>.jsonl. Each `assistant` line carries
 * `message.usage` (input / output / cache tokens) and `message.id`. There is
 * NO cost field — USD is derived as tokens x per-model list price. On a Claude
 * Max subscription that figure is *value consumed at API rates*, not money
 * billed, so the panel labels it "list-price".
 *
 * Performance: the projects dir holds large historical files. Two levers keep
 * the scan cheap — (1) files whose mtime is older than the 31-day window are
 * skipped; (2) a per-file aggregate cache keyed on (mtime,size) means an
 * unchanged file is never re-streamed. Files are streamed line-by-line.
 *
 * Dedup: Claude Code writes 2-3 JSONL lines per assistant response (streaming
 * snapshots) with the same `message.id`. We keep the LAST occurrence per id
 * (audit confirmed every snapshot carries identical usage, so this is also a
 * no-op today — but it is the correct rule if that ever changes).
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { computeUsd, modelOf, type ModelKey } from "./pricing.js";
import type { TokenSpend, TokenModelSplit, TokenSession } from "./types.js";

/** Same matching as modelOf but with an unknown-model warning side-effect. */
const warnedModels = new Set<string>();
function modelKey(model: string): ModelKey {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  if (m && !warnedModels.has(m)) {
    warnedModels.add(m);
    logger.warn({ model }, "token-reader.unknown-model — pricing as opus");
  }
  return modelOf(model);
}

function localDate(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** One day's accumulated stats within a transcript file. */
interface DayStats {
  cost: number;
  tokens: number;
  cacheRead: number;
  cacheCreate: number;
  input: number;
  byModel: Record<string, { cost: number; tokens: number }>;
}
function emptyDay(): DayStats {
  return { cost: 0, tokens: 0, cacheRead: 0, cacheCreate: 0, input: 0, byModel: {} };
}

/** A single transcript file's contribution, keyed by absolute local date. */
interface FileAggregate {
  mtimeMs: number;
  size: number;
  project: string;
  session: string;
  byDate: Record<string, DayStats>;
}

/** One deduped assistant message's cost contribution. */
interface MsgContribution {
  date: string;
  cost: number;
  tokens: number;
  cacheRead: number;
  cacheCreate: number;
  input: number;
  model: ModelKey;
}

/** Per-file aggregate cache — survives between snapshot builds. */
const fileCache = new Map<string, FileAggregate>();

/** Stream one JSONL transcript; dedup by message id (last wins); aggregate. */
async function scanFile(
  path: string,
  mtimeMs: number,
  size: number,
): Promise<FileAggregate> {
  // Keyed by message.id — the LAST snapshot of an id overwrites earlier ones.
  const byId = new Map<string, MsgContribution>();
  const noId: MsgContribution[] = [];
  let project = "";

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn final line on an actively-written file
    }
    if (!project && typeof obj.cwd === "string") project = basename(obj.cwd);
    if (obj.type !== "assistant") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;
    const model = typeof msg.model === "string" ? msg.model : "";
    // Synthetic messages are harness-injected, not real API calls — skip.
    if (model.toLowerCase().includes("synthetic")) continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const date = typeof obj.timestamp === "string" ? localDate(obj.timestamp) : null;
    if (!date) continue;

    const mk = modelKey(model);
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;

    // Cache writes: prefer the nested 5m/1h split; fall back to the flat field
    // (treated as 5m). The flat field equals 5m+1h when both are present.
    let cc5m = 0;
    let cc1h = 0;
    const ccObj = usage.cache_creation as Record<string, unknown> | undefined;
    if (ccObj && typeof ccObj === "object") {
      cc5m = Number(ccObj.ephemeral_5m_input_tokens) || 0;
      cc1h = Number(ccObj.ephemeral_1h_input_tokens) || 0;
    }
    if (cc5m + cc1h === 0) {
      cc5m = Number(usage.cache_creation_input_tokens) || 0;
    }

    const cost = computeUsd(
      { input, output, cw5m: cc5m, cw1h: cc1h, cr: cacheRead },
      mk,
    );
    const tokens = input + output + cc5m + cc1h + cacheRead;
    const contribution: MsgContribution = {
      date,
      cost,
      tokens,
      cacheRead,
      cacheCreate: cc5m + cc1h,
      input,
      model: mk,
    };

    const id = typeof msg.id === "string" ? msg.id : null;
    if (id) byId.set(id, contribution); // last snapshot wins
    else noId.push(contribution);
  }

  // Fold deduped contributions into per-date stats.
  const byDate: Record<string, DayStats> = {};
  const fold = (c: MsgContribution): void => {
    const day = (byDate[c.date] ||= emptyDay());
    day.cost += c.cost;
    day.tokens += c.tokens;
    day.cacheRead += c.cacheRead;
    day.cacheCreate += c.cacheCreate;
    day.input += c.input;
    const m = (day.byModel[c.model] ||= { cost: 0, tokens: 0 });
    m.cost += c.cost;
    m.tokens += c.tokens;
  };
  for (const c of byId.values()) fold(c);
  for (const c of noId) fold(c);

  return {
    mtimeMs,
    size,
    project: project || "unknown",
    session: basename(path).replace(/\.jsonl$/, ""),
    byDate,
  };
}

/**
 * Aggregate Claude Code usage across all recent transcripts.
 * Fault-tolerant: a missing projects dir or unreadable file yields a partial
 * (or empty) result plus an `error` string — never a thrown exception.
 */
export async function readTokenSpend(): Promise<TokenSpend> {
  const empty: TokenSpend = {
    today: 0,
    month: 0,
    tokensToday: 0,
    tokensMonth: 0,
    cacheHitRate: 0,
    byProject: [],
    byModel: [],
    topSessions: [],
    avgSession: 0,
    sessionCount: 0,
    daily: [],
  };

  // Enumerate transcript files (projects/<slug>/*.jsonl).
  const files: string[] = [];
  try {
    const slugs = await readdir(config.CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const dir = join(config.CLAUDE_PROJECTS_DIR, slug.name);
      try {
        for (const f of await readdir(dir)) {
          if (f.endsWith(".jsonl")) files.push(join(dir, f));
        }
      } catch {
        // Skip an unreadable project subdir.
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...empty, error: "no ~/.claude/projects directory" };
    return { ...empty, error: `projects dir unreadable: ${String(err)}` };
  }

  // 95-day window — covers "today", "this month" and the 13-week heatmap.
  // Older files cannot contribute and are skipped (free today: all transcripts
  // are within 31 days; this just future-proofs as history accumulates).
  const windowStart = Date.now() - 95 * 86_400_000;

  const aggregates: FileAggregate[] = [];
  let skipped = 0;
  for (const path of files) {
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    if (st.mtimeMs < windowStart) continue;
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      aggregates.push(cached);
      continue;
    }
    try {
      const agg = await scanFile(path, st.mtimeMs, st.size);
      fileCache.set(path, agg);
      aggregates.push(agg);
    } catch {
      skipped++;
    }
  }

  // Roll the per-file aggregates up into the panel shape.
  const todayStr = localDate(new Date().toISOString())!;
  const monthPrefix = todayStr.slice(0, 7);
  let today = 0;
  let tokensToday = 0;
  let month = 0;
  let tokensMonth = 0;
  let mRead = 0;
  let mCreate = 0;
  let mInput = 0;
  const projectMonth: Record<string, number> = {};
  const modelMonth: Record<string, { cost: number; tokens: number }> = {};
  const trendByDate: Record<string, number> = {};
  const sessions: TokenSession[] = [];

  for (const agg of aggregates) {
    let fileMonthCost = 0;
    for (const [date, ds] of Object.entries(agg.byDate)) {
      trendByDate[date] = (trendByDate[date] || 0) + ds.cost;
      if (date === todayStr) {
        today += ds.cost;
        tokensToday += ds.tokens;
      }
      if (date.startsWith(monthPrefix)) {
        month += ds.cost;
        tokensMonth += ds.tokens;
        mRead += ds.cacheRead;
        mCreate += ds.cacheCreate;
        mInput += ds.input;
        projectMonth[agg.project] = (projectMonth[agg.project] || 0) + ds.cost;
        for (const [mk, mv] of Object.entries(ds.byModel)) {
          const acc = (modelMonth[mk] ||= { cost: 0, tokens: 0 });
          acc.cost += mv.cost;
          acc.tokens += mv.tokens;
        }
        fileMonthCost += ds.cost;
      }
    }
    if (fileMonthCost > 0) {
      sessions.push({ session: agg.session, project: agg.project, costUSD: fileMonthCost });
    }
  }

  const byProject = Object.entries(projectMonth)
    .map(([project, costUSD]) => ({ project, costUSD }))
    .sort((a, b) => b.costUSD - a.costUSD);

  // Always three model rows in a fixed order — Sonnet/Haiku stay visible at $0
  // when unused, which is itself signal (near-zero cheap-model offload).
  const byModel: TokenModelSplit[] = (["opus", "sonnet", "haiku"] as const).map(
    (m) => ({
      model: m,
      costUSD: modelMonth[m] ? modelMonth[m].cost : 0,
      tokens: modelMonth[m] ? modelMonth[m].tokens : 0,
    }),
  );

  sessions.sort((a, b) => b.costUSD - a.costUSD);
  const topSessions = sessions.slice(0, 3);
  const avgSession = sessions.length ? month / sessions.length : 0;

  // Cache hit rate — share of prompt (non-output) tokens served from cache.
  const promptTotal = mRead + mCreate + mInput;
  const cacheHitRate = promptTotal > 0 ? mRead / promptTotal : 0;

  // Trailing 91 days of daily cost — feeds the 13-week contribution heatmap.
  const daily: Array<{ date: string; costUSD: number }> = [];
  for (let i = 90; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = localDate(d.toISOString())!;
    daily.push({ date: ds, costUSD: trendByDate[ds] || 0 });
  }

  return {
    today,
    month,
    tokensToday,
    tokensMonth,
    cacheHitRate,
    byProject,
    byModel,
    topSessions,
    avgSession,
    sessionCount: sessions.length,
    daily,
    error: skipped > 0 ? `${skipped} transcript file(s) skipped (unreadable)` : undefined,
  };
}
