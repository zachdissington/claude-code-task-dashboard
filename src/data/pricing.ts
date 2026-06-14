/**
 * Anthropic per-MTok USD list pricing — shared by token-reader.ts (Claude
 * Code transcripts) and anthropic-api-reader.ts (Admin API usage_report).
 * One source of truth means the two pieces of the Tokens panel never disagree
 * on rates. Pricing approximate as of May 2026 — keep current with
 * console.anthropic.com.
 *
 * cw5m = 5-minute cache write (1.25x input); cw1h = 1-hour cache write (2x input).
 */

export type ModelKey = "opus" | "sonnet" | "haiku";

export interface Price {
  input: number;
  output: number;
  cw5m: number;
  cw1h: number;
  cr: number;
}

export const PRICING: Record<ModelKey, Price> = {
  opus: { input: 15, output: 75, cw5m: 18.75, cw1h: 30, cr: 1.5 },
  sonnet: { input: 3, output: 15, cw5m: 3.75, cw1h: 6, cr: 0.3 },
  haiku: { input: 1, output: 5, cw5m: 1.25, cw1h: 2, cr: 0.1 },
};

/** Map a model id string ('claude-opus-4-7', etc.) to a ModelKey. */
export function modelOf(name: string): ModelKey {
  const m = (name || "").toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "opus";
}

/** USD cost of one usage line (token counts), given the model's rates. */
export function computeUsd(
  t: { input?: number; output?: number; cw5m?: number; cw1h?: number; cr?: number },
  model: ModelKey,
): number {
  const p = PRICING[model];
  return (
    ((t.input || 0) * p.input +
      (t.output || 0) * p.output +
      (t.cw5m || 0) * p.cw5m +
      (t.cw1h || 0) * p.cw1h +
      (t.cr || 0) * p.cr) /
    1_000_000
  );
}
