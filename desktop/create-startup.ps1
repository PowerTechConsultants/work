# Creates the WorkTracker shortcuts:
#   1. Desktop
#   2. Start Menu (per user)
#   3. Startup folder  -> the app starts automatically at Windows login
#
# Usage (no admin required):
#   powershell -ExecutionPolicy Bypass -File desktop\create-startup.ps1
param(
  [string]$Target = (Join-Path $PSScriptRoot 'WorkTracker.cmd'),
  [string]$WorkingDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $WorkingDirectory 'web\public\favicon.ico'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startup = Join-Path $programs 'Startup'
$desktop = [Environment]::GetFolderPath('Desktop')

foreach ($dir in @($programs, $startup)) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

function New-WorkTrackerShortcut([string]$path, [int]$windowStyle) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $Target
  $link.WorkingDirectory = $WorkingDirectory
  $link.Description = 'WorkTracker - HR Employee Work Tracker (localhost:42780)'
  $link.Arguments = ''
  if (Test-Path -LiteralPath $icon) { $link.IconLocation = "$icon,0" }
  # 7 = minimized (keeps the launcher window out of the way at login)
  $link.WindowStyle = $windowStyle
  $link.Save()
  Write-Host "created $path"
}

New-WorkTrackerShortcut (Join-Path $desktop 'WorkTracker.lnk') 1
New-WorkTrackerShortcut (Join-Path $programs 'WorkTracker.lnk') 1
New-WorkTrackerShortcut (Join-Path $startup 'WorkTracker.lnk') 7

Write-Host ''
Write-Host "WorkTracker shortcuts are ready."
Write-Host "  Desktop + Start Menu : double-click to start the app on http://localhost:42780"
Write-Host "  Startup folder       : starts automatically at Windows login"
Write-Host ''
Write-Host 'Also set MySQL to start with Windows (run once as Administrator):'
Write-Host '  Set-Service -Name MYSQL80 -StartupType Automatic'
