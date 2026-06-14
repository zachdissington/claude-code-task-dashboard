/**
 * Evening-review freshness reader — .tmp/review-state.json.
 *
 * READ-ONLY. The file is written exclusively by `.claude/scripts/record-review.py`
 * (driven by /evening-review's Summary step). Fault-tolerant: a missing file is
 * the normal "never reviewed" state (nulls, no error); a malformed file yields
 * nulls plus an `error` string.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import type { ReviewState } from "./types.js";

export async function readReviewState(): Promise<ReviewState> {
  try {
    const raw = await readFile(config.REVIEW_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      lastReviewedDate?: unknown;
      lastReviewedAt?: unknown;
    };
    return {
      lastReviewedDate:
        typeof parsed.lastReviewedDate === "string" ? parsed.lastReviewedDate : null,
      lastReviewedAt:
        typeof parsed.lastReviewedAt === "string" ? parsed.lastReviewedAt : null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { lastReviewedDate: null, lastReviewedAt: null };
    return {
      lastReviewedDate: null,
      lastReviewedAt: null,
      error: `review-state.json unreadable: ${String(err)}`,
    };
  }
}
