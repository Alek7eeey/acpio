<#
.SYNOPSIS
One-click Acpio installer (Windows): downloads the release bundle from
GitHub, unpacks it to %LOCALAPPDATA%\acpio and starts the app.

Quick start (run in PowerShell):
    irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/setup.ps1 | iex

Or use a local build:
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -ZipPath .\dist-app\acpio-win-x64.zip
#>
param(
    [string]$ZipUrl   = "https://github.com/Alek7eeey/acpio/releases/latest/download/acpio-win-x64.zip",
    [string]$ZipPath  = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\acpio",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

# --- 1. Node.js >= 20 -------------------------------------------------------
$nodeOk = $false
try {
    $nodeVer = node --version
    $nodeOk = $nodeVer -match "v(\d+)" -and [int]$Matches[1] -ge 20
} catch { }
if (-not $nodeOk) {
    Write-Host "Node.js 20+ is required. Installing via winget..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # Refresh PATH for this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nodeVer = node --version
    if (-not $nodeVer) { Write-Error "Node.js install failed. Restart the shell and run the installer again." }
    Write-Host "Node.js $nodeVer installed."
} else {
    Write-Host "Node.js $nodeVer OK"
}

# --- 2. Get the bundle ------------------------------------------------------
if ($ZipPath -eq "") {
    $tmp = Join-Path $env:TEMP "acpio-win-x64.zip"
    Write-Host "Downloading $ZipUrl ..."
    Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $tmp
    $ZipPath = $tmp
}
if (-not (Test-Path $ZipPath)) { Write-Error "Bundle not found: $ZipPath" }

# --- 3. Unpack --------------------------------------------------------------
Write-Host "Installing to $InstallDir"
if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force

# --- 4. Launch --------------------------------------------------------------
$startCmd = Join-Path $InstallDir "start.cmd"
if (-not $NoLaunch) {
    Write-Host "Starting Acpio — it opens http://localhost:3001 in your browser."
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$startCmd`"" -WindowStyle Hidden
}
Write-Host "Installed. Restart later with: $startCmd"
Write-Host "Data (SQLite) is stored in: $InstallDir\data"
