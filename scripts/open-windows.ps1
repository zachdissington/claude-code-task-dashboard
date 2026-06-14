# Open the Command Center dashboard as a chromeless app window.
#
# Modes:
#   ...open-windows.ps1                  open the window, maximized on monitor 1
#   ...open-windows.ps1 -Monitor 2       open on monitor 2 instead
#   ...open-windows.ps1 -CreateShortcut  create a pinnable desktop shortcut
#   ...open-windows.ps1 -InstallStartup  auto-open on every login
#
# The dashboard server must be running (scripts/restart.ps1).
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.

param(
  [int]$Port = 8790,
  [int]$Monitor = 1,
  [switch]$CreateShortcut,
  [switch]$InstallStartup
)

$ErrorActionPreference = "Continue"
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$iconPath   = Join-Path $projectDir "assets\dashboard-icon.ico"

# --- Locate a browser (Chrome preferred, Edge fallback) ----------------------
$browser = $null
foreach ($candidate in @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)) {
  if (Test-Path $candidate) { $browser = $candidate; break }
}
if (-not $browser) {
  Write-Host "[open-windows] no Chrome/Edge found - open this URL manually:" -ForegroundColor Red
  Write-Host "  http://localhost:$Port/"
  exit 1
}

# --- Mode: create pinnable desktop shortcut ----------------------------------
if ($CreateShortcut) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $ws = New-Object -ComObject WScript.Shell
  $lnk = Join-Path $desktop "Command Center.lnk"
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath   = $browser
  $sc.Arguments    = "--app=http://localhost:$Port/ --start-maximized"
  $sc.IconLocation = "$iconPath,0"
  $sc.Description  = "Command Center dashboard"
  $sc.Save()
  Write-Host "[open-windows] created shortcut: $lnk" -ForegroundColor Green
  Write-Host "[open-windows] right-click the desktop shortcut -> Pin to taskbar."
  exit 0
}

# --- Mode: install login-startup launcher ------------------------------------
if ($InstallStartup) {
  $startup = [Environment]::GetFolderPath("Startup")
  $cmdPath = Join-Path $startup "task-dashboard.cmd"
  $restart = Join-Path $scriptDir "restart.ps1"
  $opener  = Join-Path $scriptDir "open-windows.ps1"
  $body = "@echo off`r`n" +
          "powershell -ExecutionPolicy Bypass -File `"$restart`"`r`n" +
          "powershell -ExecutionPolicy Bypass -File `"$opener`"`r`n"
  Set-Content -Path $cmdPath -Value $body -Encoding ASCII
  Write-Host "[open-windows] installed login launcher: $cmdPath" -ForegroundColor Green
  exit 0
}

# --- Confirm the server is up ------------------------------------------------
if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host "[open-windows] nothing listening on port $Port - run scripts/restart.ps1 first" -ForegroundColor Red
  exit 1
}

# --- Win32 window helpers ----------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
if (-not ("Win" -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hi, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static List<IntPtr> Find(string title) {
    var res = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().Trim().Equals(title, StringComparison.OrdinalIgnoreCase)) res.Add(h);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
}

# --- Pick target monitor (default monitor 1, override via -Monitor) ----------
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }
$idx = $Monitor - 1
if ($idx -lt 0 -or $idx -ge $screens.Count) {
  Write-Host "[open-windows] monitor $Monitor not found (have $($screens.Count)) - using monitor 1" -ForegroundColor Yellow
  $idx = 0
}
$a = $screens[$idx].WorkingArea
$geo = @{ X = $a.X; Y = $a.Y; W = $a.Width; H = $a.Height }
Write-Host "[open-windows] launching Command Center on monitor $($idx + 1) of $($screens.Count)"

# --- Launch ------------------------------------------------------------------
Start-Process -FilePath $browser -ArgumentList @(
  "--app=http://localhost:$Port/",
  "--window-position=$($geo.X),$($geo.Y)",
  "--window-size=$($geo.W),$($geo.H)"
)

# Restore -> move onto the target monitor -> maximize there. SW_RESTORE=9,
# SW_MAXIMIZE=3. MoveWindow positions the window on its monitor; maximize then
# fills that monitor's work area (taskbar stays visible).
function Place($title, $geo) {
  $hwnds = [Win]::Find($title)
  foreach ($h in $hwnds) {
    [Win]::ShowWindow($h, 9) | Out-Null
    [Win]::MoveWindow($h, $geo.X, $geo.Y, $geo.W, $geo.H, $true) | Out-Null
    [Win]::ShowWindow($h, 3) | Out-Null
  }
  return $hwnds.Count
}

$placed = 0
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Milliseconds 350
  if ($placed -eq 0) { $placed = Place "Command Center" $geo }
  if ($placed -gt 0) { break }
}
Place "Command Center" $geo | Out-Null

if ($placed -gt 0) {
  Write-Host "[open-windows] placed + maximized Command Center on monitor $($idx + 1)" -ForegroundColor Green
} else {
  Write-Host "[open-windows] launched, but window title was not found in time - re-run" -ForegroundColor Yellow
}
