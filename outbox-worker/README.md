# Dashboard outbox Worker (Part C — offline durability)

An always-on Cloudflare Worker + KV that holds phone writes made while the PC is
**off**, so nothing is lost. The PC drains it on boot + every 30s
(`../src/data/outbox-drain.ts`), replaying each queued write through the local
`POST /action` (the same canonical writers a live click uses). The filesystem
task store stays the single source of truth — this is a transient write-ahead
queue, never read as state.

## Flow

```
Phone (PC off) ──POST /outbox──▶ Worker + KV  (always up)
PC boot/30s ──GET /outbox──▶ replay each via local /action ──POST /outbox/ack──▶ KV delete
```

Idempotency: each `clientId` the PC applies is recorded in `.tmp/outbox-applied.json`
and skipped on re-fetch, so a write whose ack failed is never double-applied.

## Routes

- `POST /outbox` — phone enqueue `{clientId, payload}`. Auth `X-Outbox-Token` (baked into the page/SW).
- `GET /outbox` — PC lists pending. Auth `X-Outbox-Admin` (PC-only).
- `POST /outbox/ack` — PC clears `{clientIds}`. Auth `X-Outbox-Admin`.

## Deploy (one-time — uses your Cloudflare Workers account)

1. `cd outbox-worker`
2. `npx wrangler kv namespace create OUTBOX_KV` → paste the printed id into `wrangler.toml` (`<KV_NAMESPACE_ID>`).
3. Generate two secrets: `python -c "import secrets;print(secrets.token_hex(32))"` (run twice → token + admin token).
4. `npx wrangler secret put OUTBOX_TOKEN` (the phone-enqueue token) and `npx wrangler secret put OUTBOX_ADMIN_TOKEN` (the PC drain token).
5. `npx wrangler deploy` → note the Worker URL (e.g. `https://dashboard-outbox.<sub>.workers.dev`).
6. In the **workspace `.env`** set:
   - `DASHBOARD_OUTBOX_URL=https://dashboard-outbox.<sub>.workers.dev`
   - `DASHBOARD_OUTBOX_TOKEN=<the OUTBOX_TOKEN>` (injected into the page/SW so the phone can enqueue)
   - `DASHBOARD_OUTBOX_ADMIN_TOKEN=<the OUTBOX_ADMIN_TOKEN>` (PC drains/acks)
7. Restart the dashboard (`pwsh ../scripts/restart.ps1`). Until these are set, the drain + the SW's offline-enqueue are inert (no behaviour change).

## Status

Worker code + PC drain shipped + verified (drain replay + ack + idempotency tested end-to-end against a stub). **Not deployed** — Part C goes live once Zach runs the deploy steps above. The service worker (`/sw.js`) caches the shell so the app opens when the PC/tunnel is down and re-routes failed `/action` writes here.
