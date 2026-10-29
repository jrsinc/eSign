# Method 365: update the Windows production server to the latest code on GitHub (main).
# Run in PowerShell opened as administrator. Steps:
#   1. zip the data folder into backups\ (newest 10 kept), 2. download the new code and packages,
#   3. restart the service, 4. wait until healthy, 5. if it isn't, go back to the previous version.
param(
  [string]$InstallDir = 'C:\Method365',
  [string]$ServiceName = 'Method365'
)
$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Healthy($port) {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 2
    try { if ((Invoke-RestMethod "http://localhost:$port/healthz" -TimeoutSec 3).ok) { return $true } } catch { }
  }
  return $false
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this in PowerShell opened as administrator.' -ForegroundColor Yellow; exit 1 }
Set-Location $InstallDir
$port = (Get-Content .env | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
if (-not $port) { $port = '3000' }
$prev = git rev-parse HEAD
$prevShort = git rev-parse --short HEAD

Step 'Backing up the data folder'
New-Item -ItemType Directory -Force backups | Out-Null
$zip = "backups\predeploy-$(Get-Date -Format yyyyMMdd-HHmmss)-$prevShort.zip"
Compress-Archive -Path data\* -DestinationPath $zip
Get-ChildItem backups\predeploy-*.zip | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item
Write-Host "    $zip"

Step 'Downloading the new version'
git fetch --quiet origin
$new = git rev-parse --short origin/main
if ($new -eq $prevShort) { Write-Host '    Already up to date.' -ForegroundColor Green; exit 0 }
git merge --ff-only --quiet origin/main
npm ci --omit=dev --no-audit --no-fund | Out-Null
Write-Host "    $prevShort -> $new"

Step 'Restarting Method 365'
nssm restart $ServiceName | Out-Null
if (Healthy $port) { Write-Host "`nUpdated to $new and healthy." -ForegroundColor Green; exit 0 }

Write-Host "`nVersion $new is not healthy: going back to $prevShort." -ForegroundColor Red
Get-Content logs\method365.log -Tail 20 -ErrorAction SilentlyContinue
git reset --hard --quiet $prev
npm ci --omit=dev --no-audit --no-fund | Out-Null
nssm restart $ServiceName | Out-Null
if (Healthy $port) { Write-Host "Back on $prevShort and healthy. Data from before the update: $zip" -ForegroundColor Yellow } else { Write-Host 'The previous version is not healthy either: check logs\method365.log now.' -ForegroundColor Red }
exit 1
