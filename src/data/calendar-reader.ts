/**
 * Calendar reader — feeds the right-rail "Today's meetings" panel.
 *
 * Shells out to calendar-read-window.py (virtual-assistant-agent scripts) for a
 * live 5-day Google Calendar pull. Meetings are PULL-only by design — no webhook,
 * no cached mirror (see .claude/plans/2026-05-29-calendar-in-plan-day.md). The
 * script itself degrades to {events: [], error} on any auth/API failure, so an
 * error here means "could not verify", never "no meetings".
 */

import { config } from "../config.js";
import { runPythonJson } from "./python-bridge.js";
import type { CalendarEvent, CalendarToday } from "./types.js";

interface WindowEvent {
  title?: string;
  start?: string;
  end?: string;
  date?: string;
  is_today?: boolean;
  all_day?: boolean;
  duration_mins?: number | null;
  meet_link?: string | null;
}

interface WindowOutput {
  events?: WindowEvent[];
  error?: string | null;
}

export async function readCalendar(): Promise<CalendarToday> {
  const base: CalendarToday = { today: [], prepHorizon: [], meetingMinutesToday: 0 };

  let out: WindowOutput;
  try {
    out = await runPythonJson<WindowOutput>(config.CALENDAR_WINDOW_SCRIPT, ["--days", "5"]);
  } catch (err) {
    base.error = `calendar-read-window.py failed: ${String(err)}`;
    return base;
  }
  if (out.error) {
    base.error = out.error;
    return base;
  }

  for (const ev of out.events ?? []) {
    const row: CalendarEvent = {
      title: ev.title || "(No title)",
      start: ev.start || "",
      end: ev.end || "",
      date: ev.date || "",
      isToday: Boolean(ev.is_today),
      allDay: Boolean(ev.all_day),
      durationMins: typeof ev.duration_mins === "number" ? ev.duration_mins : null,
      meetLink: ev.meet_link ?? null,
    };
    if (row.isToday) {
      base.today.push(row);
      // All-day events don't eat capacity — only timed meetings do.
      if (!row.allDay && row.durationMins != null) {
        base.meetingMinutesToday += row.durationMins;
      }
    } else {
      base.prepHorizon.push(row);
    }
  }
  return base;
}
