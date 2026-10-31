<#
.SYNOPSIS
Acpio installer through npm: makes sure Node.js 20+ is there, installs the
package globally (`npm i -g acpio`) and checks that the `acpio` command answers.

The npm road instead of the portable zip (scripts/setup.ps1): nothing is unpacked
into a folder of its own, updates come from `npm i -g acpio@latest`, and the
install scripts are named on the command line - npm 11.17+ refuses to run them
unless it is told which packages may, and better-sqlite3/node-pty build their
native modules in exactly those scripts.

Quick start (run in PowerShell):
    irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/install.ps1 | iex

Pin a release, or install without starting the app, from a saved copy:
    irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/install.ps1 -OutFile install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.1.42 -NoLaunch
#>
param(
    [string]$Version = "latest",
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

# --- 2. Install from npm ----------------------------------------------------
# npm 11.17+ blocks install scripts by default, and they are what builds the
# native modules - name the three packages that need them.
$npmArgs = @("install", "-g", "acpio@$Version")
$npmVer = ((npm --version) -join " ").Trim()
$allowScripts = ""
try {
    if ([version]$npmVer -ge [version]"11.17.0") {
        $allowScripts = "--allow-scripts=acpio,better-sqlite3,node-pty"
        $npmArgs += $allowScripts
    }
} catch { }
Write-Host "Installing acpio@$Version with npm $npmVer ..."
npm @npmArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error ("npm install failed (exit $LASTEXITCODE). See the log above - the npm 11.17+ rows " +
                 "about blocked install scripts are the usual cause; rerun with $allowScripts.")
}

# --- 3. Check the command and its native module -----------------------------
$npmPrefix = ((npm prefix -g) -join " ").Trim()
$shim = Join-Path $npmPrefix "acpio.cmd"
if (-not (Test-Path $shim)) { $shim = "acpio" }
$acpioVer = & $shim --version
if ($LASTEXITCODE -ne 0) {
    Write-Error "The acpio command does not start (exit $LASTEXITCODE). Rerun the install with $allowScripts added."
}
Write-Host "Acpio $acpioVer installed: $shim"

# `--version` answers before the server is loaded, so the SQLite module is looked
# for on disk: a blocked install script leaves no binary, and the app then fails
# at its first query. Nested is where a global install keeps it, the flat path is
# what npm does when it hoists the dependency.
$modulePaths = @(
    (Join-Path $npmPrefix "node_modules\acpio\node_modules\better-sqlite3\build\Release\better_sqlite3.node"),
    (Join-Path $npmPrefix "node_modules\better-sqlite3\build\Release\better_sqlite3.node")
)
$sqlite = $modulePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sqlite) {
    Write-Error ("The native SQLite module was not built - npm skipped the install scripts. " +
                 "Rerun: npm i -g acpio@$Version $allowScripts")
}

# --- 4. Launch --------------------------------------------------------------
if (-not $NoLaunch) {
    Write-Host "Starting Acpio - it opens http://localhost:18741 in your browser."
    Start-Process -FilePath $shim -WindowStyle Hidden
}
Write-Host "Start it later with: acpio"
Write-Host "Data (SQLite) is stored in: $env:LOCALAPPDATA\acpio\data"
