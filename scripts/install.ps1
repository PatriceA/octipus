# Octipus installer for Windows PowerShell 5.1+ / PowerShell 7.
# Run: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.ps1)))
# Flags mirror install.sh: -Quick (five-prompt setup that ends running),
# -NonInteractive, -SkipSetup, -Start, -Desktop (prints the Tauri prerequisites).
param([switch]$Quick, [switch]$NonInteractive, [switch]$SkipSetup, [switch]$Start, [switch]$Desktop)
$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:OCTIPUS_REPO) { $env:OCTIPUS_REPO } else { 'https://github.com/PatriceA/octipus.git' }
$Branch = if ($env:OCTIPUS_BRANCH) { $env:OCTIPUS_BRANCH } else { 'main' }
$InstallDir = if ($env:OCTIPUS_INSTALL_DIR) { $env:OCTIPUS_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.octipus\app' }
$BinDir = if ($env:OCTIPUS_BIN_DIR) { $env:OCTIPUS_BIN_DIR } else { Join-Path $env:USERPROFILE '.octipus\bin' }

# Native command failures do not throw on Windows PowerShell. Check every exit.
function Run-Native([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE). Installation stopped." }
}
# curl.exe: the octi.cmd launcher uses it for health checks (ships with Windows 10 1803+).
foreach ($tool in @('git', 'node', 'npm.cmd', 'curl.exe')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is required. Install Git for Windows and Node.js >=24.19 (including npm), reopen PowerShell, then retry."
    }
}
Write-Host 'Checking Node.js >=24.19.0 (required for crypto and module-loader support)...'
Run-Native node @('-e', 'const [a,b]=process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit(a>24||(a===24&&b>=19)?0:1)')
if (-not $SkipSetup -and -not $NonInteractive -and -not $env:CI -and [Console]::IsInputRedirected) {
    throw 'No terminal available for setup. Use -NonInteractive with OCTIPUS_SETUP_ADMIN_USER/PASS, or -SkipSetup.'
}
if (Test-Path (Join-Path $InstallDir '.git')) {
    $dirty = & git -C $InstallDir status --porcelain
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Existing checkout has local changes. Commit or stash them before updating.' }
    Run-Native git @('-C', $InstallDir, 'fetch', 'origin', $Branch)
    Run-Native git @('-C', $InstallDir, 'checkout', $Branch)
    Run-Native git @('-C', $InstallDir, 'pull', '--ff-only', 'origin', $Branch)
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
    Run-Native git @('clone', '--branch', $Branch, '--depth', '1', $RepoUrl, $InstallDir)
}
Push-Location $InstallDir
try {
    $BackupEnv = Join-Path $env:USERPROFILE '.octipus\.env.uninstall-backup'
    if ((Test-Path $BackupEnv) -and -not (Test-Path '.env')) { Copy-Item $BackupEnv '.env' }
    Run-Native npm.cmd @('ci', '--include=dev')
    Run-Native npm.cmd @('--prefix', 'web', 'ci', '--include=dev')
    Run-Native npm.cmd @('run', 'build')
    Run-Native npm.cmd @('--prefix', 'web', 'run', 'build')
    Run-Native npm.cmd @('--prefix', 'mcp-server', 'ci', '--include=dev')
    Run-Native npm.cmd @('--prefix', 'mcp-server', 'run', 'build')
    & npm.cmd run audit:all
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Dependency audit needs attention. Review the reports above; rerun npm run audit:all from the checkout.' }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # A .cmd shim requires neither administrator privileges nor symlink support.
    # OEM encoding: cmd.exe reads the console code page, so a user profile path
    # with accented characters survives (ASCII turned them into '?').
    $launcher = Join-Path $InstallDir 'bin\octi.cmd'
    Set-Content -Encoding OEM -Path (Join-Path $BinDir 'octi.cmd') -Value "@echo off`r`ncall `"$launcher`" %*`r`nexit /b %errorlevel%"
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($UserPath -split ';') -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable('Path', "$BinDir;$UserPath", 'User')
    }
    $env:PATH = "$BinDir;$env:PATH"
    if ($Desktop) {
        Write-Host 'Desktop client prerequisites (installed separately on Windows):'
        Write-Host '  - Rust toolchain: https://rustup.rs'
        Write-Host '  - Microsoft Edge WebView2 runtime (bundled with Windows 11; https://developer.microsoft.com/microsoft-edge/webview2/)'
        Write-Host '  - Visual Studio Build Tools with the "Desktop development with C++" workload'
        Write-Host 'Then: octi desktop'
    }
    if (-not $SkipSetup) {
        $setupArgs = @('run', 'setup')
        if ($NonInteractive) { $setupArgs += @('--', '--non-interactive') }
        elseif ($Quick) { $setupArgs += @('--', '--quick') }
        Run-Native npm.cmd $setupArgs
    }
    if ($Start -and -not $Quick) {
        if (-not (Test-Path '.env')) { throw 'Run setup before starting Octipus.' }
        Run-Native $launcher @('start', 'web')
    }
    Write-Host "Installed at $InstallDir. CLI: $BinDir\octi.cmd"
    Write-Host 'Open a new terminal to pick up the PATH change, or use the absolute path above now.'
    if (-not $Quick) { Write-Host 'Next: octi start web, then open http://localhost:3007 and log in with your setup account.' }
    Write-Host 'Use octi doctor, octi status, octi logs, octi stop; octi tui opens terminal chat.'
} finally { Pop-Location }
