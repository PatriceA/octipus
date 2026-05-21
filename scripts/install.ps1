# Octipus one-shot installer for Windows.
#
# Usage:
#   iex (irm https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.ps1)
#
# Mirrors the bash installer: detects platform, clones the repo into
# %LOCALAPPDATA%\octipus\app, installs deps, runs `bun run setup`.

$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:OCTIPUS_REPO) { $env:OCTIPUS_REPO } else { 'https://github.com/PatriceA/octipus.git' }
$Branch     = if ($env:OCTIPUS_BRANCH) { $env:OCTIPUS_BRANCH } else { 'main' }
$InstallDir = if ($env:OCTIPUS_INSTALL_DIR) { $env:OCTIPUS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'octipus\app' }

function Say($msg)  { Write-Host $msg -ForegroundColor White }
function Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[x]  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  Octipus - installing."
Write-Host "  One nervous system, eight arms."
Write-Host ""

# ─── git ──────────────────────────────────────────────────────────────────
try { $gitVer = (git --version) 2>$null; Ok "git: $gitVer" } catch {
  Err "git not found. Install Git for Windows from https://git-scm.com first."
  exit 1
}

# ─── bun ──────────────────────────────────────────────────────────────────
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
  Warn "bun not found — installing via official PowerShell script..."
  iex (irm https://bun.sh/install.ps1)
  $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}
$bunVer = (bun --version) 2>$null
Ok "bun: $bunVer"

# ─── Clone or update ──────────────────────────────────────────────────────
if (Test-Path (Join-Path $InstallDir '.git')) {
  Say "Found existing checkout — pulling latest..."
  Push-Location $InstallDir
  git fetch origin $Branch --quiet
  git checkout $Branch --quiet
  git pull --quiet --ff-only origin $Branch
  Pop-Location
} else {
  $parent = Split-Path $InstallDir -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  Say "Cloning $RepoUrl → $InstallDir"
  git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
}
Ok "Repository ready at $InstallDir"
Set-Location $InstallDir

# ─── Deps ─────────────────────────────────────────────────────────────────
Say "Installing backend dependencies..."
bun install --silent
Ok "Backend dependencies installed"

if (Test-Path (Join-Path $InstallDir 'web')) {
  Say "Installing web dependencies..."
  Push-Location (Join-Path $InstallDir 'web')
  bun install --silent
  Pop-Location
  Ok "Web dependencies installed"
}

# ─── Setup wizard ─────────────────────────────────────────────────────────
Write-Host ""
Say "Launching the interactive setup wizard..."
Write-Host ""
bun run setup

Write-Host ""
Ok "Installation complete."
Write-Host ""
Write-Host "Next:"
Write-Host "  cd $InstallDir"
Write-Host "  octi start         # full stack"
Write-Host "  octi tui           # terminal chat"
Write-Host "  octi doctor        # check what's wired"
Write-Host ""
