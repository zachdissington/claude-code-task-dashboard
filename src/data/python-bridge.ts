/**
 * Bridge to the workspace task-store Python scripts.
 *
 * The dashboard is a pure presenter: it shells out to the already-verified
 * scripts under .claude/scripts/ rather than reimplementing frontmatter parsing
 * and project grouping in TypeScript (which would create a second drifting copy
 * of load-bearing logic). Adds zero npm dependencies.
 *
 * burndown.py is ONLY ever called with `--format json` — that path prints to
 * stdout and writes nothing. The markdown path writes a file; never use it.
 * execFile (no shell) is used so the workspace path's space is never a hazard.
 */

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { config, TOOL_ROOT, WORKSPACE_ROOT } from "../config.js";
import { logger } from "../logger.js";
import type { BurndownResult } from "./types.js";

const execFileAsync = promisify(execFile);

const BURNDOWN_SCRIPT = join(config.SCRIPTS_DIR, "burndown.py");

/**
 * Demo-mode fixtures (DASHBOARD_DEMO=1). A standalone/public clone has no
 * workspace task store and no `.claude/scripts`, so the bridge serves bundled
 * JSON from `mocks/` instead of spawning Python. burndown + closures are
 * provided; any other script falls through to a throw, which the caller's
 * `safe()` wrapper turns into an empty panel.
 */
function readDemoFixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(TOOL_ROOT, "mocks", file), "utf-8")) as T;
}
const DEMO_SCRIPT_FIXTURES: Record<string, string> = {
  "closures-since.py": "closures.json",
};

/**
 * Run `burndown.py --format json` and parse the result.
 * Throws on spawn failure / non-zero exit / unparseable stdout — callers
 * convert that into a per-panel `error` so one bad source never blanks the page.
 */
export async function runBurndown(): Promise<BurndownResult> {
  if (config.DEMO) return readDemoFixture<BurndownResult>("burndown.json");
  const { stdout, stderr } = await execFileAsync(
    config.PYTHON_BIN,
    [BURNDOWN_SCRIPT, "--format", "json"],
    {
      cwd: WORKSPACE_ROOT,
      timeout: config.PYTHON_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  // burndown.py prints a non-fatal `warning:` to stderr for unparseable task
  // files. Log it but do not treat it as failure — only a non-zero exit (which
  // execFileAsync rejects on) is a real failure.
  if (stderr && stderr.trim()) {
    logger.warn({ stderr: stderr.trim() }, "burndown.stderr");
  }
  const parsed = JSON.parse(stdout) as BurndownResult;
  if (typeof parsed.total !== "number" || !Array.isArray(parsed.groups)) {
    throw new Error("burndown.py JSON missing expected fields");
  }
  return parsed;
}

/**
 * Run an arbitrary workspace Python script and JSON.parse its stdout.
 * Same guards as runBurndown (no shell, timeout, windowsHide). Used for
 * suggest_training.py. Throws on spawn failure / non-zero exit / bad JSON —
 * callers convert that into a per-panel `error`.
 */
export async function runPythonJson<T>(
  scriptPath: string,
  args: string[] = [],
): Promise<T> {
  if (config.DEMO) {
    const fixture = DEMO_SCRIPT_FIXTURES[basename(scriptPath)];
    if (fixture) return readDemoFixture<T>(fixture);
    throw new Error(`demo mode: no fixture for ${basename(scriptPath)}`);
  }
  const { stdout, stderr } = await execFileAsync(
    config.PYTHON_BIN,
    [scriptPath, ...args],
    {
      cwd: WORKSPACE_ROOT,
      timeout: config.PYTHON_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (stderr && stderr.trim()) {
    logger.warn({ stderr: stderr.trim(), script: scriptPath }, "python-script.stderr");
  }
  return JSON.parse(stdout) as T;
}

/** Result of a write-action script run — never throws, the caller maps a
 *  non-zero exit / spawn failure to an HTTP 502 with the captured stderr. */
export interface PythonActionResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a workspace task-store WRITE script (update-task.py et al.) and
 * return its exit status + captured output. Unlike runPythonJson this never
 * throws and never JSON.parses — these scripts print small JSON or plain text
 * and the only thing the endpoint needs is "did it succeed". Same no-shell /
 * timeout / windowsHide guards so a path with spaces is never a hazard.
 */
export async function runPythonAction(
  scriptPath: string,
  args: string[],
): Promise<PythonActionResult> {
  if (config.DEMO) {
    return { ok: false, code: null, stdout: "", stderr: "demo mode: writes are disabled" };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      config.PYTHON_BIN,
      [scriptPath, ...args],
      {
        cwd: WORKSPACE_ROOT,
        timeout: config.PYTHON_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    // execFileAsync rejects on non-zero exit, timeout, or spawn failure. The
    // rejection carries stdout/stderr/code when the process actually ran.
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    const code = typeof e.code === "number" ? e.code : null;
    logger.warn({ script: scriptPath, code, stderr: (e.stderr || "").trim() }, "python-action.failed");
    return {
      ok: false,
      code,
      stdout: e.stdout || "",
      stderr: (e.stderr || e.message || "python action failed").toString(),
    };
  }
}

/** One-time startup probe — surfaces a missing/wrong Python interpreter early. */
export async function probePython(): Promise<void> {
  if (config.DEMO) {
    logger.info("demo mode: Python probe skipped (mock fixtures in use)");
    return;
  }
  try {
    const { stdout } = await execFileAsync(config.PYTHON_BIN, ["--version"], {
      timeout: 5000,
      windowsHide: true,
    });
    logger.info({ python: stdout.trim(), bin: config.PYTHON_BIN }, "python.probe-ok");
  } catch (err) {
    logger.error(
      { err, bin: config.PYTHON_BIN },
      "python.probe-failed — set TASK_DASHBOARD_PYTHON to a valid interpreter",
    );
  }
}
