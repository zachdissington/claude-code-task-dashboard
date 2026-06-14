/**
 * Business KPI reader — data/business-metrics.json.
 *
 * READ-ONLY here. The JSON is now AUTO-FED by the finance-dashboard exporter
 * (`Internal/finance-dashboard/app/src/export/export-business-metrics.ts`,
 * `npm run export:metrics`): it writes `contracts[]` (active Stripe subs — none
 * today), `scoreboard.ar_unpaid` (Σ receivables), and `deferred.cac` (cold-email
 * spend). MRR / active-clients / next-renewal are DERIVED here from `contracts`.
 * Only `scoreboard.pipeline_value` + `proposals_outstanding` stay hand-entered
 * (client-domain). Mapping: finance-dashboard/decisions/2026-06-13-business-metrics-mapping.md.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import type { BusinessMetrics, ContractLine } from "./types.js";

interface RawContract {
  client?: string;
  monthly_value?: number;
  status?: string;
  renewal_date?: string;
}

interface RawBusiness {
  last_updated?: string;
  claude_subscription_usd?: number;
  contracts?: RawContract[];
  scoreboard?: {
    pipeline_value?: number | null;
    proposals_outstanding?: number | null;
    ar_unpaid?: number | null;
  };
  deferred?: {
    cac?: number | null;
    ltv_cac_ratio?: number | null;
    outreach_volume?: number | null;
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export async function readBusiness(): Promise<BusinessMetrics> {
  const empty: BusinessMetrics = {
    lastUpdated: null,
    staleDays: null,
    mrr: null,
    activeClients: null,
    nextRenewal: null,
    claudeSubscriptionUsd: null,
    contracts: [],
    pipelineValue: null,
    proposalsOutstanding: null,
    arUnpaid: null,
    cac: null,
    ltvCacRatio: null,
    outreachVolume: null,
  };

  let raw: RawBusiness;
  try {
    raw = JSON.parse(await readFile(config.BUSINESS_METRICS_PATH, "utf-8")) as RawBusiness;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ...empty, error: "business-metrics.json not found" };
    }
    return { ...empty, error: `business-metrics.json unreadable: ${String(err)}` };
  }

  let staleDays: number | null = null;
  if (raw.last_updated) {
    const t = new Date(raw.last_updated).getTime();
    if (!Number.isNaN(t)) {
      staleDays = Math.floor((Date.now() - t) / 86_400_000);
    }
  }

  // Normalise the contracts array to the typed shape.
  const rawContracts = Array.isArray(raw.contracts) ? raw.contracts : [];
  const contracts: ContractLine[] = rawContracts.map((c) => ({
    client: String(c.client ?? ""),
    monthlyValue: num(c.monthly_value) ?? 0,
    status: String(c.status ?? ""),
    renewalDate: c.renewal_date ? String(c.renewal_date) : null,
  }));

  // Derive MRR / active-clients / next-renewal from the contracts array.
  // An empty array means "not yet entered" — leave mrr/activeClients null so
  // the panel honestly shows "--" rather than a fabricated $0.
  const active = contracts.filter((c) => c.status.toLowerCase() === "active");
  const mrr = contracts.length ? active.reduce((s, c) => s + c.monthlyValue, 0) : null;
  const activeClients = contracts.length ? active.length : null;

  const today = localToday();
  const future = active
    .filter((c): c is ContractLine & { renewalDate: string } =>
      c.renewalDate != null && c.renewalDate >= today,
    )
    .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
  const nextRenewal = future.length
    ? { client: future[0].client, date: future[0].renewalDate }
    : null;

  const sb = raw.scoreboard || {};
  const d = raw.deferred || {};
  return {
    lastUpdated: raw.last_updated || null,
    staleDays,
    mrr,
    activeClients,
    nextRenewal,
    claudeSubscriptionUsd: num(raw.claude_subscription_usd),
    contracts,
    pipelineValue: num(sb.pipeline_value),
    proposalsOutstanding: num(sb.proposals_outstanding),
    arUnpaid: num(sb.ar_unpaid),
    cac: num(d.cac),
    ltvCacRatio: num(d.ltv_cac_ratio),
    outreachVolume: num(d.outreach_volume),
  };
}
