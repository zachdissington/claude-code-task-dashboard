/**
 * Vitest setup — runs before any test module (hence before config.ts is
 * imported and reads the env). Pins a known write token so the guard/round-trip
 * tests authenticate, without depending on whatever DASHBOARD_WRITE_TOKEN the
 * developer's .env happens to hold.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

process.env.DASHBOARD_WRITE_TOKEN = "test-write-token-do-not-ship";

/**
 * Hermetic default for standalone/public clones. The write round-trip suites
 * shell out to the private-workspace Python writers (`.claude/scripts/*.py`);
 * a clone ships none of them. Probe for a real workspace by walking up for
 * `.claude/scripts` (mirrors config.ts's resolveWorkspaceRoot). If none is
 * found and the developer hasn't already picked a mode, run in DEMO so reads
 * serve the bundled `mocks/` fixtures and the app boots with no backend — the
 * write suites detect the same condition via helpers.ts `FULL` and skip. The
 * private workspace finds `.claude/scripts`, stays out of DEMO, and runs the
 * full suite. Decided here, before config.ts reads the env at import time.
 */
function hasWorkspaceWriter(): boolean {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".claude", "scripts"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

if (!process.env.DASHBOARD_DEMO && !hasWorkspaceWriter()) {
  process.env.DASHBOARD_DEMO = "1";
}

/**
 * Standalone clones don't ship the workspace `.tmp/` tree, so the read-path unit
 * tests (review-state + session-bindings) that write a fixture then read it back
 * have nowhere to write. Create it once in demo mode. config resolves these under
 * WORKSPACE_ROOT, which for a clone is the repo root == the `npm test` cwd.
 */
if (process.env.DASHBOARD_DEMO) {
  try {
    mkdirSync(join(process.cwd(), ".tmp", "session_bindings"), { recursive: true });
  } catch {
    /* best-effort */
  }
}
