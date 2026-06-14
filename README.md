# claude-code-task-dashboard

A read-only live web dashboard for a **filesystem markdown task store** — the kind
[Claude Code](https://claude.com/claude-code) workspaces use, where each task is a
`.md` file with YAML frontmatter under `tasks/` / `refs/`. It restores the
glanceable visibility a hosted task UI gives you: a browser tab you keep open and
glance at — backlog by project, today's plan, closures, and Claude usage — without
leaving the filesystem as the source of truth.

It is a **presenter**, not an editor. Task mutation stays in your CLI/agent flow;
the dashboard shells out to the same task-store scripts so there is one writer and
no drift. (An optional write-back endpoint exists for ticking off personal
right-rail items — off unless you set a token.)

> Personal tool, no SLA. Built for a single operator's local workflow and shared as
> a reference implementation. Localhost-only by default — `127.0.0.1` is the
> security boundary, since the page exposes your whole task store.

## Quick start (demo mode — no workspace, no Python)

```sh
npm install
cp .env.example .env        # ships with DASHBOARD_DEMO=1
npm run build
npm start                   # http://localhost:8790
```

Demo mode serves bundled fixtures from `mocks/` so the whole UI renders with no
backend. To run against a real workspace, set `DASHBOARD_DEMO=0` (or unset it) and
either run the dashboard from inside a workspace that has `.claude/scripts/`, or
point it at one with `TASK_DASHBOARD_WORKSPACE_ROOT`.

## Local dev

```sh
npm run dev        # tsx watch, hot reload
npm run test:run   # vitest (write-endpoint tests run against a real task store)
```

## Running against your own workspace

The dashboard expects a workspace exposing these scripts (it never reimplements
their logic):

| Panel | Source |
|-------|--------|
| Backlog by project | `.claude/scripts/burndown.py --format json` |
| Closures (last 14d) | `.claude/scripts/closures-since.py` |
| Pull candidates | derived — top task of each project group |
| In-flight / bound | `.tmp/session_bindings/*.json` |
| Capture queue | `.tmp/capture_queue.json` |
| Shipped activity | `.tmp/shipped_queue.json` |
| Backlog-size trend | `data/backlog-history.json` (self-accumulated daily) |
| Write-back (optional) | `.claude/scripts/update-task.py` via `POST /action` |

Right-rail panels (training / meals / calendar) shell out to optional helper
scripts and collapse cleanly when those aren't present.

## Endpoints

- `GET /` — the dashboard page
- `GET /snapshot` — full JSON payload (all panels)
- `GET /health` — `{ ok, workspace, port }`
- `GET /events` — SSE `refresh` stream
- `POST /action` — guarded write-back (Origin/Host + `DASHBOARD_WRITE_TOKEN`); 503 when no token is set

## Configuration

See [`.env.example`](.env.example) for every override (port, Python interpreter,
workspace root, write token, Cloudflare Tunnel origin, outbox Worker, Anthropic
Admin API key).

## Notes

- `dist/` is not committed; always `npm run build` before `npm start`.
- Optional mobile access is via a Cloudflare Tunnel (`cloudflared/config.yml`
  template) with an offline write-ahead queue (`outbox-worker/`).

## License

MIT — see [LICENSE](LICENSE).
