/**
 * Direct readers for the three live-state `.tmp` files.
 *
 * These are plain JSON — no frontmatter/markdown parsing, no project grouping —
 * so they are read directly with `fs` rather than via a Python script. Every
 * reader is fault-tolerant: a missing or malformed file yields an empty result
 * plus an `error` string, never a thrown exception.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { BindingRecord, CaptureItem, ShippedItem } from "./types.js";

interface Result<T> {
  data: T;
  error?: string;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

/** .tmp/capture_queue.json — array of pending capture items (often empty []). */
export async function readCaptureQueue(): Promise<Result<CaptureItem[]>> {
  const path = join(config.TMP_DIR, "capture_queue.json");
  try {
    const parsed = await readJson(path);
    if (!Array.isArray(parsed)) return { data: [], error: "capture_queue.json is not an array" };
    return { data: parsed as CaptureItem[] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: [] }; // absent == empty queue
    return { data: [], error: `capture_queue.json unreadable: ${String(err)}` };
  }
}

/** .tmp/shipped_queue.json — array of shipped-work records, newest last. */
export async function readShippedQueue(): Promise<Result<ShippedItem[]>> {
  const path = join(config.TMP_DIR, "shipped_queue.json");
  try {
    const parsed = await readJson(path);
    if (!Array.isArray(parsed)) return { data: [], error: "shipped_queue.json is not an array" };
    return { data: parsed as ShippedItem[] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: [] };
    return { data: [], error: `shipped_queue.json unreadable: ${String(err)}` };
  }
}

/** .tmp/session_bindings/*.json — one file per actively-bound session. */
export async function readSessionBindings(): Promise<Result<BindingRecord[]>> {
  const dir = join(config.TMP_DIR, "session_bindings");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: [] }; // dir absent == nothing bound
    return { data: [], error: `session_bindings unreadable: ${String(err)}` };
  }
  const items: BindingRecord[] = [];
  const skippedFiles: string[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(join(dir, f), "utf-8");
    } catch {
      skippedFiles.push(f);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Recover the one realistic corruption: a stray non-JSON-aware writer left a
      // Windows path with UNescaped single backslashes (C:\Dev\… instead of
      // C:\\Dev\\…). These files are all-single-backslash, so doubling every
      // backslash restores valid JSON. Only runs after a real parse failure, so
      // valid files are never touched. (Happened once when a parallel terminal's
      // manual crosstalk test wrote into the shared live .tmp/ — see
      // plans/2026-06-03-malformed-binding-investigation.md.)
      try {
        parsed = JSON.parse(raw.replace(/\\/g, "\\\\"));
      } catch {
        skippedFiles.push(f);
        continue;
      }
    }
    if (parsed && typeof parsed === "object" && "task_title" in parsed) {
      items.push(parsed as BindingRecord);
    } else {
      skippedFiles.push(f);
    }
  }
  items.sort((a, b) => (b.bound_at || "").localeCompare(a.bound_at || ""));
  return skippedFiles.length > 0
    ? { data: items, error: `${skippedFiles.length} binding file(s) skipped (malformed): ${skippedFiles.join(", ")}` }
    : { data: items };
}
