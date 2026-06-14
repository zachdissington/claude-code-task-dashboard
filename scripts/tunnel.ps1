# Run the task-dashboard Cloudflare Tunnel (mobile access, Part B).
#
# Prereq (one-time, interactive — see decisions/2026-06-13-dashboard-mobile-access.md):
#   cloudflared tunnel login
#   cloudflared tunnel create dashboard
#   # then fill cloudflared/config.yml's <TUNNEL_UUID>/<TUNNEL_HOSTNAME>,
#   # route DNS: cloudflared tunnel route dns dashboard <TUNNEL_HOSTNAME>
#   # create a Cloudflare Access application + policy (email = Zach) for the hostname
#   # set DASHBOARD_PUBLIC_ORIGIN=https://<TUNNEL_HOSTNAME> in the workspace .env
#
# Then this runs the tunnel (foreground; Ctrl-C to stop). The dashboard must be
# up on localhost:8790 (pm2 process `task-dashboard`).

$ErrorActionPreference = "Stop"
$cfg = Join-Path $PSScriptRoot "..\cloudflared\config.yml"

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Error "cloudflared not installed. Run: winget install --id Cloudflare.cloudflared"
}
if ((Get-Content $cfg -Raw) -match "<TUNNEL_UUID>|<TUNNEL_HOSTNAME>") {
  Write-Error "cloudflared/config.yml still has <PLACEHOLDER> values. Complete the one-time setup first (see decisions/2026-06-13-dashboard-mobile-access.md)."
}

Write-Host "Starting dashboard tunnel (Ctrl-C to stop)..."
cloudflared tunnel --config $cfg run
