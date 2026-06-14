# Safe-restart the task-dashboard.
#
# `pm2 restart` races on port release (Windows frees the socket slowly; pm2's
# relaunch fires before the FD is free) and crash-loops the new process. This
# script: kills the PID on port 8790, waits for release, clears pm2 state,
# rebuilds dist if stale, starts fresh, and verifies a new PID is listening.
#
# Run from anywhere (this machine has Windows PowerShell 5.1, NOT pwsh/PS7):
#   powershell -ExecutionPolicy Bypass -File ./scripts/restart.ps1
# (If PowerShell 7 is ever installed: pwsh ./scripts/restart.ps1 also works.)

$ErrorActionPreference = "Stop"
$port = 8790
$appName = "task-dashboard"

# Resolve to project root (script lives in <root>/scripts/).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot
Write-Host "[restart] project root: $projectRoot"

# --- Step 1: kill whatever holds the port ------------------------------------
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $pidToKill = $existing[0].OwningProcess
  Write-Host "[restart] stopping PID $pidToKill on port $port"
  Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "[restart] port $port already free"
}

# --- Step 2: wait for port release -------------------------------------------
# Windows frees the FD slowly under load; 5s wasn't enough on a busy box and the
# next pm2 start hit EADDRINUSE. Wait up to 15s. (roast-v2 F2)
$attempts = 0
while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and ($attempts -lt 30)) {
  Start-Sleep -Milliseconds 500
  $attempts++
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "[restart] port $port still bound after 15s - abort" -ForegroundColor Red
  exit 1
}

# pm2 writes harmless diagnostics to stderr (e.g. "process not found" on a
# first run). Under -ErrorAction Stop, PS 5.1 turns that into a terminating
# NativeCommandError. Drop to Continue for the pm2/npm steps below — each one
# checks $LASTEXITCODE explicitly, so real failures are still caught.
$ErrorActionPreference = "Continue"

# --- Step 3: clear pm2 state -------------------------------------------------
& pm2 delete $appName 2>$null | Out-Null

# --- Step 4: rebuild if dist is stale ----------------------------------------
$srcFiles = Get-ChildItem -Path "src" -Recurse -File -ErrorAction SilentlyContinue
$distFiles = Get-ChildItem -Path "dist" -Recurse -File -ErrorAction SilentlyContinue
$srcLatest = if ($srcFiles) { ($srcFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime } else { $null }
$distLatest = if ($distFiles) { ($distFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime } else { $null }

if (-not $distLatest -or ($srcLatest -and $srcLatest -gt $distLatest)) {
  Write-Host "[restart] dist stale - rebuilding"
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[restart] build failed" -ForegroundColor Red
    exit 1
  }
}

# --- Step 5: start -----------------------------------------------------------
& pm2 start ecosystem.config.cjs | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[restart] pm2 start failed" -ForegroundColor Red
  exit 1
}

# --- Step 6: verify online ---------------------------------------------------
Start-Sleep -Seconds 3
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host "[restart] failed - nothing listening on port $port after restart" -ForegroundColor Red
  & pm2 logs $appName --nostream --lines 15 2>$null
  exit 1
}
$newPid = $listening[0].OwningProcess
Write-Host "[restart] $appName online - PID $newPid bound to port $port" -ForegroundColor Green
Write-Host "[restart] open http://localhost:$port"
exit 0
