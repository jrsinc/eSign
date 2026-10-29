# Method 365: set up (or repair) a Windows production server PC.
# Run in PowerShell opened as administrator. Safe to run again: it installs only what is missing.
#   1. Installs Node.js LTS, Git, NSSM (runs Method 365 as a Windows service) and cloudflared.
#   2. Downloads the code to C:\Method365 (or updates it) and installs its packages.
#   3. Stops and tells you if .env or the data folder still needs copying in.
#   4. Installs the "Method365" Windows service: starts with Windows, restarts itself if it stops.
#   5. Waits until Method 365 reports healthy at http://localhost:3000/healthz.
# See WINDOWS-SERVER.md for the whole procedure.
param(
  [string]$InstallDir = 'C:\Method365',
  [string]$Repo = 'https://github.com/jrsinc/eSign.git',
  [string]$ServiceName = 'Method365',
  [switch]$NewInstall   # start with no data (a brand-new system instead of a move from another PC)
)
$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "    $text" -ForegroundColor Green }
function Stop-With($text) { Write-Host "`n$text" -ForegroundColor Yellow; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'Please run this in PowerShell opened as administrator (right-click PowerShell > Run as administrator).' }

# 1. Tools
Step 'Installing the tools Method 365 needs (only those missing)'
$tools = @(
  @{ Id = 'OpenJS.NodeJS.LTS'; Command = 'node' },
  @{ Id = 'Git.Git'; Command = 'git' },
  @{ Id = 'NSSM.NSSM'; Command = 'nssm' },
  @{ Id = 'Cloudflare.cloudflared'; Command = 'cloudflared' }
)
foreach ($t in $tools) {
  Refresh-Path
  if (Get-Command $t.Command -ErrorAction SilentlyContinue) { Done "$($t.Command) is installed"; continue }
  Write-Host "    installing $($t.Id) ..."
  winget install --id $t.Id --exact --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
  if (-not (Get-Command $t.Command -ErrorAction SilentlyContinue)) { Stop-With "$($t.Id) did not install. Install it by hand, then run this script again." }
  Done "$($t.Command) installed"
}
Done "Node.js $(node -v), $(git --version)"

# 2. Code
Step "Getting the code into $InstallDir"
if (Test-Path (Join-Path $InstallDir '.git')) {
  git -C $InstallDir pull --ff-only
  Done 'Updated to the latest version'
} else {
  if ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Where-Object { $_.Name -notin '.env', 'data' })) {
    Stop-With "$InstallDir exists and is not a Method 365 checkout. Move its contents away (keep .env and data), then run again."
  }
  $keep = @{}
  foreach ($n in '.env', 'data') { if (Test-Path (Join-Path $InstallDir $n)) { $keep[$n] = Join-Path $env:TEMP "m365-keep-$n"; Move-Item (Join-Path $InstallDir $n) $keep[$n] -Force } }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Force -Recurse }
  git clone $Repo $InstallDir
  foreach ($n in $keep.Keys) { Move-Item $keep[$n] (Join-Path $InstallDir $n) -Force }
  Done 'Downloaded'
}
Push-Location $InstallDir
npm ci --omit=dev --no-audit --no-fund | Out-Null
Done 'Packages installed'

# 3. Settings and data
Step 'Checking settings (.env) and data'
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  Pop-Location
  Stop-With @"
.env is missing. Copy the .env file from the old PC into $InstallDir
(or for a brand-new system: copy .env.example to .env and fill it in), then run this script again.
"@
}
$settings = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $settings[$Matches[1]] = $Matches[2].Trim() }
if ($settings['BASE_URL'] -notmatch '^https://') { Write-Host "    Note: BASE_URL is '$($settings['BASE_URL'])'. For the live system set BASE_URL=https://esign.method365sign.com" -ForegroundColor Yellow }
$dataDir = Join-Path $InstallDir 'data'
if (-not (Test-Path (Join-Path $dataDir 'db.json')) -and -not $NewInstall) {
  Pop-Location
  Stop-With @"
No data found in $dataDir.
Moving from another PC: stop Method 365 there, copy its whole 'data' folder into $InstallDir, then run this script again.
Starting fresh instead: run this script again with -NewInstall.
"@
}
# Only administrators and the system account may read .env (it holds the mailbox password).
icacls $envFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Done '.env found (readable by administrators and the service only)'
if (Test-Path (Join-Path $dataDir 'db.json')) { Done "data found ($((Get-ChildItem $dataDir -Recurse -File).Count) files)" } else { Done 'starting with no data (-NewInstall)' }

# 4. Windows service
Step "Installing the '$ServiceName' Windows service"
$node = (Get-Command node).Source
$logs = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) { nssm install $ServiceName $node server.js | Out-Null }
nssm set $ServiceName Application $node | Out-Null
nssm set $ServiceName AppParameters server.js | Out-Null
nssm set $ServiceName AppDirectory $InstallDir | Out-Null
nssm set $ServiceName DisplayName 'Method 365' | Out-Null
nssm set $ServiceName Description 'Method 365 electronic signatures (Jupiter Research Services)' | Out-Null
nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
nssm set $ServiceName AppExit Default Restart | Out-Null
nssm set $ServiceName AppRestartDelay 5000 | Out-Null
nssm set $ServiceName AppStdout (Join-Path $logs 'method365.log') | Out-Null
nssm set $ServiceName AppStderr (Join-Path $logs 'method365.log') | Out-Null
nssm set $ServiceName AppRotateFiles 1 | Out-Null
nssm set $ServiceName AppRotateOnline 1 | Out-Null
nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
nssm restart $ServiceName | Out-Null
Done 'Service installed: starts with Windows and restarts itself if it stops'

# 5. Health check
Step 'Waiting for Method 365 to start'
$port = if ($settings['PORT']) { $settings['PORT'] } else { '3000' }
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep 2
  try { $ok = (Invoke-RestMethod "http://localhost:$port/healthz" -TimeoutSec 3).ok } catch { }
}
Pop-Location
if (-not $ok) {
  Write-Host "`nMethod 365 did not start. Last lines of the log:" -ForegroundColor Red
  Get-Content (Join-Path $logs 'method365.log') -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Done "Method 365 is running: http://localhost:$port"
Write-Host @"

Next (WINDOWS-SERVER.md, part D): create the Cloudflare tunnel for esign.method365sign.com and run its
'cloudflared.exe service install <token>' command here, in this administrator window.
Logs: $logs\method365.log   ·   Status: nssm status $ServiceName   ·   Update later: deploy\windows\update.ps1
"@ -ForegroundColor Green
