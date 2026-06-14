/**
 * Minimal YAML-frontmatter reader for task `.md` files.
 *
 * Task files carry a flat `key: value` frontmatter block between `---` fences
 * (see .claude/companion_docs/task-schema.md). This reads only that flat block — no
 * nested structures, no anchors — which is all the task schema uses. The
 * canonical parser is task_helpers.py; this is a deliberately tiny presenter-
 * side reader so the personal panels need no Python spawn per file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Parse the leading `---` frontmatter block into a flat string map. */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Normalise CRLF/CR → LF: the per-line `(.*)$` match below won't cross a
  // trailing `\r`, so a CRLF file would silently parse to {} (and drop the task
  // from every panel). Tolerate whatever line ending a writer/editor produced.
  text = text.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const block = text.slice(3, end);
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    // Strip matching surrounding quotes the task writer emits on some values.
    if (
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2) ||
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/** A task file's frontmatter plus its path. */
export interface TaskMeta {
  path: string;
  fm: Record<string, string>;
}

/**
 * Read every `*.md` in `dir`, returning each file's frontmatter.
 * A missing directory yields `[]`; an unreadable file is skipped.
 */
export async function readTaskDir(dir: string): Promise<TaskMeta[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const out: TaskMeta[] = [];
  for (const f of files) {
    try {
      const text = await readFile(join(dir, f), "utf-8");
      out.push({ path: join(dir, f), fm: parseFrontmatter(text) });
    } catch {
      // Skip an unreadable file rather than failing the whole panel.
    }
  }
  return out;
}
