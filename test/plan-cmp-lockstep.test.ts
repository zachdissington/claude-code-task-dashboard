import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { FULL } from "./helpers.js";

/**
 * Lockstep guard: the dashboard's inlined `planCmp` (the green NEXT hero sort)
 * must agree, task-for-task, with the Python `task_helpers.plan_sort_key` that
 * `/next` and `/plan-day` use. They diverged once on an arbitrary alphabetical
 * group-key tiebreak (the 2026-06-08 incident); the fix put an oldest-committed
 * age key ahead of the group cluster. This test runs BOTH comparators over the
 * same rows and asserts identical order, so the two can't silently drift again.
 */

const HTML_TS = join(fileURLToPath(new URL("../src/server/html.ts", import.meta.url)));
const PY = process.env.TASK_DASHBOARD_PYTHON || "python";

/** Pull PRI_RANK + priKey + planCmp verbatim out of html.ts and make planCmp
 *  callable — this tests the REAL comparator text the browser ships, not a copy. */
function extractPlanCmp(): (a: unknown, b: unknown) => number {
  const src = readFileSync(HTML_TS, "utf-8");
  const grab = (re: RegExp, name: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${name} from html.ts`);
    return m[0];
  };
  const priRank = grab(/var PRI_RANK=\{[^}]*\};/, "PRI_RANK");
  const priKey = grab(/function priKey\(p\)\{[^}]*\}/, "priKey");
  const planCmp = grab(/function planCmp\(a,b\)\{[\s\S]*?\n\}/, "planCmp");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${priRank}\n${priKey}\n${planCmp}\nreturn planCmp;`)() as (
    a: unknown,
    b: unknown,
  ) => number;
}

/** The 2026-06-08 incident set: three all-medium, all-internal tasks. Under the
 *  old (group-alphabetical) tiebreak the freshly-created claude-tooling task won;
 *  the correct answer is the oldest-committed task (Voice Jarvis, created 06-01). */
const FIXTURE = [
  { id: "T-2026-06-08-001", priority: "medium", group: "claude-tooling", group_klass: "skill", rank: 4, time_estimate: 90, scheduled_at: null, created: "2026-06-08T14:02:50Z" },
  { id: "T-2026-06-07-004", priority: "medium", group: "sustainability", group_klass: "internal", rank: 4, time_estimate: 90, scheduled_at: null, created: "2026-06-07T15:29:16Z" },
  { id: "T-2026-06-01-001", priority: "medium", group: "voice-jarvis", group_klass: "internal", rank: 5, time_estimate: 180, scheduled_at: null, created: "2026-06-01T00:23:10Z" },
];

/** Map a neutral fixture row into the shape Python plan_sort_key expects. */
function toPyRow(r: (typeof FIXTURE)[number]) {
  return {
    fs_id: r.id,
    Priority: r.priority.charAt(0).toUpperCase() + r.priority.slice(1),
    _client_first: r.group_klass === "client",
    _group: r.group,
    rank: r.rank,
    "Time Estimate": r.time_estimate,
    scheduled_at: r.scheduled_at,
    created: r.created,
  };
}

/** Order FIXTURE by the Python plan_sort_key (shell out — the suite already uses
 *  python freely). Returns the ordered fs_ids. */
function pythonOrder(rows: ReturnType<typeof toPyRow>[]): string[] {
  const code = [
    "import sys, json",
    `sys.path.insert(0, r'${join(config.SCRIPTS_DIR)}')`,
    "from task_helpers import plan_sort_key",
    "rows = json.load(sys.stdin)",
    "rows.sort(key=plan_sort_key)",
    "print(json.dumps([r['fs_id'] for r in rows]))",
  ].join("\n");
  const out = execFileSync(PY, ["-c", code], { input: JSON.stringify(rows), encoding: "utf-8" });
  return JSON.parse(out.trim());
}

describe.skipIf(!FULL)("planCmp ⇆ plan_sort_key lockstep", () => {
  it("orders oldest-committed first when priority + client-first tie", () => {
    const planCmp = extractPlanCmp();
    const jsOrder = FIXTURE.slice().sort(planCmp).map((r) => r.id);
    // Oldest created (06-01) → newest (06-08), NOT alphabetical group order.
    expect(jsOrder).toEqual(["T-2026-06-01-001", "T-2026-06-07-004", "T-2026-06-08-001"]);
  });

  it("JS planCmp and Python plan_sort_key produce identical order", () => {
    const planCmp = extractPlanCmp();
    const jsOrder = FIXTURE.slice().sort(planCmp).map((r) => r.id);
    const pyOrder = pythonOrder(FIXTURE.map(toPyRow));
    expect(jsOrder).toEqual(pyOrder);
  });
});
