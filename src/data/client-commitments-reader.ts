/**
 * Client-commitments manual layer — data/client-commitments.json.
 *
 * READ-ONLY, OPTIONAL. The Client commitments panel works without this file:
 * open/high task counts come from the burndown client groups (see
 * snapshot.ts). This file adds the only thing the task store cannot supply —
 * a next promised deliverable + due date per client. A missing file is normal
 * and not an error; the panel just shows counts.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";

/** One manual client entry — keyed to a client name (e.g. "client-alpha"). */
export interface ClientCommitmentEntry {
  client: string;
  nextDeliverable: string | null;
  dueDate: string | null;
}

interface RawFile {
  clients?: Array<{ client?: string; next_deliverable?: string; due_date?: string }>;
}

export async function readClientCommitments(): Promise<{
  data: ClientCommitmentEntry[];
  error?: string;
}> {
  try {
    const raw = JSON.parse(
      await readFile(config.CLIENT_COMMITMENTS_PATH, "utf-8"),
    ) as RawFile;
    const list = Array.isArray(raw.clients) ? raw.clients : [];
    return {
      data: list.map((c) => ({
        client: String(c.client ?? ""),
        nextDeliverable: c.next_deliverable ? String(c.next_deliverable) : null,
        dueDate: c.due_date ? String(c.due_date) : null,
      })),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { data: [] }; // optional file — absence is fine
    return { data: [], error: `client-commitments.json unreadable: ${String(err)}` };
  }
}
