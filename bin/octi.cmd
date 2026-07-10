@echo off
setlocal enabledelayedexpansion

:: Enable UTF-8 output and ANSI escape sequences
chcp 65001 >nul 2>&1

:: Enable virtual terminal processing for ANSI colors
for /f "tokens=3" %%A in ('reg query "HKCU\Console" /v VirtualTerminalLevel 2^>nul') do set "_VT=%%A"
if not defined _VT (
    reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1
)

:: ─── ANSI color codes ─────────────────────────────────────────────────────
:: We use PowerShell to write the escape character into a variable
for /f %%E in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%E"
set "RED=%ESC%[0;31m"
set "GREEN=%ESC%[0;32m"
set "YELLOW=%ESC%[1;33m"
set "BLUE=%ESC%[0;34m"
set "CYAN=%ESC%[0;36m"
set "BOLD=%ESC%[1m"
set "DIM=%ESC%[2m"
set "NC=%ESC%[0m"

:: ─── Octipus CLI (Windows) ────────────────────────────────────────────────
:: Single-command management for Octipus.
::
:: Usage:
::   octi start [--dev]    Start backend + web UI
::   octi stop             Stop all Octipus processes
::   octi restart [--dev]  Restart everything
::   octi status           Show running state
::   octi logs             Tail backend logs
::   octi open             Open web UI in browser
:: ────────────────────────────────────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_DIR=%%~fI"

set "STATE_DIR=%USERPROFILE%\.octipus"
set "PID_FILE_BACKEND=%STATE_DIR%\backend.pid"
set "PID_FILE_WEB=%STATE_DIR%\web.pid"
set "LOG_FILE=%STATE_DIR%\backend.log"
set "WEB_LOG_FILE=%STATE_DIR%\web.log"

if not defined API_PORT set "API_PORT=3005"
if not defined WEB_PORT set "WEB_PORT=3007"
:: Desktop dev web server (tauri:dev → next dev -p 3008). Distinct from
:: WEB_PORT so the desktop and the browser web UI never collide.
if not defined DESKTOP_DEV_PORT set "DESKTOP_DEV_PORT=3008"

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"

:: Detect storage mode from .env
set "STORAGE_MODE=embedded"
if exist "%PROJECT_DIR%\.env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b "STORAGE_MODE=" "%PROJECT_DIR%\.env" 2^>nul') do (
        set "STORAGE_MODE=%%b"
    )
)

set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=help"

if "%COMMAND%"=="setup" goto :cmd_setup
if "%COMMAND%"=="start" goto :cmd_start
if "%COMMAND%"=="stop" goto :cmd_stop
if "%COMMAND%"=="restart" goto :cmd_restart
if "%COMMAND%"=="status" goto :cmd_status
if "%COMMAND%"=="doctor" goto :cmd_doctor
if "%COMMAND%"=="logs" goto :cmd_logs
if "%COMMAND%"=="open" goto :cmd_open
if "%COMMAND%"=="tui" goto :cmd_tui
if "%COMMAND%"=="edit" goto :cmd_edit
if "%COMMAND%"=="desktop" goto :cmd_desktop
if "%COMMAND%"=="uninstall" goto :cmd_uninstall
if "%COMMAND%"=="help" goto :cmd_help
if "%COMMAND%"=="--help" goto :cmd_help
if "%COMMAND%"=="-h" goto :cmd_help

echo   %RED%x%NC% Unknown command: %COMMAND%
echo.
goto :cmd_help

:: ─── Banner ──────────────────────────────────────────────────────────────
:print_banner
echo.
echo   %CYAN%%BOLD%+===================================+
echo   ^|                  O C T I P U S         ^|
echo   +===================================+%NC%
echo.
exit /b 0

:: ─── Helpers ────────────────────────────────────────────────────────────────

:kill_port
:: Kill all processes listening on a given port
:: Usage: call :kill_port 3005
set "_PORT=%~1"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %_PORT% -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
exit /b 0

:check_port
:: Check if a port is reachable (returns errorlevel 0 if yes)
:: Usage: call :check_port 5432
set "_CP=%~1"
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('localhost', %_CP%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
exit /b %errorlevel%

:kill_all_octipus
:: Kill tracked processes and free ports
call :kill_port %API_PORT%
call :kill_port %WEB_PORT%
:: Kill orphan wrapper cmd.exe processes spawned by start_hidden (they hold log file locks)
if exist "%STATE_DIR%\run_backend.cmd" (
    powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"CommandLine like '%%run_backend.cmd%%'\" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)
if exist "%STATE_DIR%\run_webui.cmd" (
    powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"CommandLine like '%%run_webui.cmd%%'\" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)
:: Also kill any stray bun processes from our project directory
powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"Name='bun.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*octipus*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
if exist "%PID_FILE_WEB%" del "%PID_FILE_WEB%"
exit /b 0

:start_hidden
:: Launch a process in a hidden window (no visible console)
:: Usage: call :start_hidden "name" "working_dir" "command" "log_file" [append]
set "_SH_BAT=%STATE_DIR%\run_%~1.cmd"
if "%~5"=="append" (
    > "%_SH_BAT%" echo @cd /d "%~2" ^&^& %~3 ^>^>"%~4" 2^>^&1
) else (
    > "%_SH_BAT%" echo @cd /d "%~2" ^&^& %~3 ^>"%~4" 2^>^&1
)
powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c %_SH_BAT%' -WindowStyle Hidden"
exit /b 0

:: ─── Start ──────────────────────────────────────────────────────────────────
:cmd_start
call :print_banner

:: Kill any existing processes first (clean slate)
call :kill_all_octipus
timeout /t 1 /nobreak >nul

:: Check bun
where bun >nul 2>&1
if errorlevel 1 (
    echo   %RED%x%NC% bun is not installed. Install from https://bun.sh
    exit /b 1
)

set "DEV_MODE=false"
if "%~2"=="--dev" set "DEV_MODE=true"
if "%~2"=="-d" set "DEV_MODE=true"

:: Check required services (only for external storage mode)
if "!STORAGE_MODE!"=="external" (
    echo   %BLUE%-%NC% Checking services...
    call :check_port 5432
    if errorlevel 1 (
        echo   %RED%x%NC% PostgreSQL not reachable on port 5432
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d db%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% PostgreSQL is reachable

    call :check_port 6380
    if errorlevel 1 (
        echo   %RED%x%NC% Valkey not reachable on port 6380
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d valkey%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% Valkey is reachable
) else (
    echo   %GREEN%v%NC% Embedded mode %DIM%(PGlite + in-memory cache^)%NC%
)

:: Start backend
if "!DEV_MODE!"=="true" (
    echo   %BLUE%-%NC% Starting backend %DIM%(dev mode with hot reload^)%NC%...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run dev" "%LOG_FILE%"
) else (
    echo   %BLUE%-%NC% Starting backend...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run start" "%LOG_FILE%"
)

:: Wait for backend to be healthy BEFORE starting web UI
echo   %BLUE%-%NC% Waiting for backend to be ready...
set "ATTEMPTS=0"
:start_health_loop
if !ATTEMPTS! geq 60 goto :start_health_timeout
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 goto :start_health_ok
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
goto :start_health_loop

:start_health_ok
echo   %GREEN%v%NC% Backend is ready on port %API_PORT%

:: Clear Next.js cache so code changes take effect
echo   %BLUE%-%NC% Clearing web UI cache...
if exist "%PROJECT_DIR%\web\.next" rmdir /s /q "%PROJECT_DIR%\web\.next"
if exist "%PROJECT_DIR%\web\node_modules\.cache" rmdir /s /q "%PROJECT_DIR%\web\node_modules\.cache"

:: Start web UI only after backend is confirmed healthy
if "!DEV_MODE!"=="true" (
    echo   %BLUE%-%NC% Starting web UI %DIM%(dev mode^)%NC%...
    call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
) else (
    echo   %BLUE%-%NC% Building web UI...
    cd /d "%PROJECT_DIR%\web"
    call bun run build >"%WEB_LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo   %YELLOW%^^!%NC% Production build failed, using dev mode instead
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
    ) else (
        echo   %BLUE%-%NC% Starting web UI...
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run start" "%WEB_LOG_FILE%" append
    )
)

timeout /t 2 /nobreak >nul
echo   %GREEN%v%NC% Web UI starting on port %WEB_PORT%

:: Open browser
echo   %BLUE%-%NC% Opening browser...
start "" "http://localhost:%WEB_PORT%"

echo.
echo   %GREEN%%BOLD%Octipus is running!%NC%
echo.
echo   Web UI:    %CYAN%http://localhost:%WEB_PORT%%NC%
echo   API:       %CYAN%http://localhost:%API_PORT%%NC%
echo   API Docs:  %CYAN%http://localhost:%API_PORT%/swagger%NC%
echo.
echo   %BOLD%Commands:%NC%
echo   octi status    Show running state
echo   octi logs      View backend logs
echo   octi stop      Stop everything
echo.
exit /b 0

:start_health_timeout
echo   %RED%x%NC% Backend health check timed out (60s^)
echo     %DIM%Check logs: octi logs%NC%
:: Kill the backend we started since it didn't come up
call :kill_port %API_PORT%
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
exit /b 1

:: ─── Stop ───────────────────────────────────────────────────────────────────
:cmd_stop
call :print_banner

echo   %BLUE%-%NC% Stopping Octipus...
call :kill_all_octipus

echo   %GREEN%v%NC% Octipus stopped
echo.
exit /b 0

:: ─── Restart ────────────────────────────────────────────────────────────────
:cmd_restart
call :print_banner

set "DEV_MODE=false"
if "%~2"=="--dev" set "DEV_MODE=true"
if "%~2"=="-d" set "DEV_MODE=true"

:: ── 1. STOP ─────────────────────────────────────────────────────────────────
echo   %BLUE%-%NC% Stopping all processes...
call :kill_all_octipus
timeout /t 2 /nobreak >nul
echo   %GREEN%v%NC% Processes stopped

:: ── 2. CLEAR CACHES ─────────────────────────────────────────────────────────
echo   %BLUE%-%NC% Clearing caches...
if exist "%PROJECT_DIR%\web\.next" rmdir /s /q "%PROJECT_DIR%\web\.next"
if exist "%PROJECT_DIR%\web\node_modules\.cache" rmdir /s /q "%PROJECT_DIR%\web\node_modules\.cache"
echo   %GREEN%v%NC% Caches cleared
echo.

:: ── 3. START ─────────────────────────────────────────────────────────────────

:: Check bun
where bun >nul 2>&1
if errorlevel 1 (
    echo   %RED%x%NC% bun is not installed. Install from https://bun.sh
    exit /b 1
)

:: Check required services (only for external storage mode)
if "!STORAGE_MODE!"=="external" (
    echo   %BLUE%-%NC% Checking services...
    call :check_port 5432
    if errorlevel 1 (
        echo   %RED%x%NC% PostgreSQL not reachable on port 5432
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d db%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% PostgreSQL is reachable

    call :check_port 6380
    if errorlevel 1 (
        echo   %RED%x%NC% Valkey not reachable on port 6380
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d valkey%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% Valkey is reachable
) else (
    echo   %GREEN%v%NC% Embedded mode %DIM%(PGlite + in-memory cache^)%NC%
)

:: Start backend
if "!DEV_MODE!"=="true" (
    echo   %BLUE%-%NC% Starting backend %DIM%(dev mode with hot reload^)%NC%...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run dev" "%LOG_FILE%"
) else (
    echo   %BLUE%-%NC% Starting backend...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run start" "%LOG_FILE%"
)

:: Wait for backend to be healthy BEFORE starting web UI
echo   %BLUE%-%NC% Waiting for backend to be ready...
set "ATTEMPTS=0"
:restart_health_loop
if !ATTEMPTS! geq 60 goto :restart_health_timeout
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 goto :restart_health_ok
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
goto :restart_health_loop

:restart_health_ok
echo   %GREEN%v%NC% Backend is ready on port %API_PORT%

:: Start web UI (cache already cleared above)
if "!DEV_MODE!"=="true" (
    echo   %BLUE%-%NC% Starting web UI %DIM%(dev mode^)%NC%...
    call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
) else (
    echo   %BLUE%-%NC% Building web UI...
    cd /d "%PROJECT_DIR%\web"
    call bun run build >"%WEB_LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo   %YELLOW%^^!%NC% Production build failed, using dev mode instead
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
    ) else (
        echo   %BLUE%-%NC% Starting web UI...
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run start" "%WEB_LOG_FILE%" append
    )
)

timeout /t 2 /nobreak >nul
echo   %GREEN%v%NC% Web UI starting on port %WEB_PORT%

:: Open browser
echo   %BLUE%-%NC% Opening browser...
start "" "http://localhost:%WEB_PORT%"

echo.
echo   %GREEN%%BOLD%Octipus is running!%NC%
echo.
echo   Web UI:    %CYAN%http://localhost:%WEB_PORT%%NC%
echo   API:       %CYAN%http://localhost:%API_PORT%%NC%
echo   API Docs:  %CYAN%http://localhost:%API_PORT%/swagger%NC%
echo.
exit /b 0

:restart_health_timeout
echo   %RED%x%NC% Backend health check timed out (60s^)
echo     %DIM%Check logs: octi logs%NC%
:: Kill the backend we started since it didn't come up
call :kill_port %API_PORT%
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
exit /b 1

:: ─── Status ─────────────────────────────────────────────────────────────────
:cmd_status
call :print_banner

echo   %BOLD%Process Status%NC%
echo.

curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 (
    echo   %GREEN%v%NC% Backend:  running on port %API_PORT%
) else (
    echo   %RED%x%NC% Backend:  not running
)

curl -sf http://localhost:%WEB_PORT% >nul 2>&1
if not errorlevel 1 (
    echo   %GREEN%v%NC% Web UI:   running on port %WEB_PORT%
) else (
    echo   %RED%x%NC% Web UI:   not running
)

echo.
echo   %BOLD%Service Status%NC%  %DIM%(!STORAGE_MODE! mode^)%NC%
echo.

if "!STORAGE_MODE!"=="external" (
    call :check_port 5432
    if errorlevel 1 (
        echo   %RED%x%NC% PostgreSQL: not reachable
    ) else (
        echo   %GREEN%v%NC% PostgreSQL: reachable %DIM%(port 5432^)%NC%
    )

    call :check_port 6380
    if errorlevel 1 (
        echo   %RED%x%NC% Valkey: not reachable
    ) else (
        echo   %GREEN%v%NC% Valkey: reachable %DIM%(port 6380^)%NC%
    )
) else (
    echo   %GREEN%v%NC% PGlite:     embedded database
    echo   %GREEN%v%NC% Cache:      in-memory
)

call :check_port 11434
if errorlevel 1 (
    echo   %YELLOW%^^!%NC% Ollama:     not reachable %DIM%(optional^)%NC%
) else (
    echo   %GREEN%v%NC% Ollama:     reachable %DIM%(port 11434^)%NC%
)

call :check_port 4000
if errorlevel 1 (
    echo   %YELLOW%^^!%NC% LiteLLM:    not reachable %DIM%(optional^)%NC%
) else (
    echo   %GREEN%v%NC% LiteLLM:    reachable %DIM%(port 4000^)%NC%
)

echo.
echo   %BOLD%URLs%NC%
echo   Web UI:    %CYAN%http://localhost:%WEB_PORT%%NC%
echo   API:       %CYAN%http://localhost:%API_PORT%%NC%
echo   API Docs:  %CYAN%http://localhost:%API_PORT%/swagger%NC%
echo.
exit /b 0

:: ─── Logs ───────────────────────────────────────────────────────────────────
:cmd_logs
if "%~2"=="--web" (
    if exist "%WEB_LOG_FILE%" (
        type "%WEB_LOG_FILE%"
        echo.
        echo   %DIM%[Watching %WEB_LOG_FILE%]%NC%
        powershell -NoProfile -Command "Get-Content '%WEB_LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   %RED%x%NC% No web log file found. Start Octipus first.
    )
) else (
    if exist "%LOG_FILE%" (
        type "%LOG_FILE%"
        echo.
        echo   %DIM%[Watching %LOG_FILE%]%NC%
        powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   %RED%x%NC% No log file found. Start Octipus first.
    )
)
exit /b 0

:: ─── Open ───────────────────────────────────────────────────────────────────
:cmd_open
start "" "http://localhost:%WEB_PORT%"
echo   %GREEN%v%NC% Opening %CYAN%http://localhost:%WEB_PORT%%NC%
exit /b 0

:: ─── TUI (terminal chat) ────────────────────────────────────────────────────
:cmd_tui
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if errorlevel 1 (
    echo   %RED%x%NC% Backend is not running on port %API_PORT%
    echo     %DIM%Start it first: octi start%NC%
    exit /b 1
)
:: Capture the invocation cwd before we cd into the project dir, so the
:: dev session opens pinned to the folder the user ran `octi tui` from
:: (claude-style). An explicit `--project /other` in the forwarded args
:: still wins because the entry-point parser uses the last `--project`.
set "USER_CWD=%CD%"
echo   %GREEN%v%NC% Connecting TUI to gateway at localhost:%API_PORT%...
echo     %DIM%Project: %USER_CWD%%NC%
cd /d "%PROJECT_DIR%"
bun run src/tui-pi/index.ts --project "%USER_CWD%" %~2 %~3 %~4 %~5 %~6 %~7 %~8
exit /b %errorlevel%

:: ─── Edit (TUI editor) ──────────────────────────────────────────────────────
:cmd_edit
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if errorlevel 1 (
    echo   %RED%x%NC% Backend is not running on port %API_PORT%
    echo     %DIM%Start it first: octi start%NC%
    exit /b 1
)
set "USER_CWD=%CD%"
echo   %GREEN%v%NC% Launching TUI editor (gateway at localhost:%API_PORT%)...
echo     %DIM%Project: %USER_CWD%%NC%
cd /d "%PROJECT_DIR%"
:: Default project = invocation cwd; user-supplied `--project /path`
:: in the forwarded args overrides it.
bun run src/tui-editor/index.ts --project "%USER_CWD%" %~2 %~3 %~4 %~5 %~6 %~7 %~8
exit /b %errorlevel%

:: ─── Setup (first-run / re-config wizard) ───────────────────────────────────
:cmd_setup
:: Interactive first-run wizard: storage, secrets, admin account, provider,
:: default model, capabilities. Same code path as `bun run setup`.
cd /d "%PROJECT_DIR%"
bun run scripts/setup-wizard.ts %~2 %~3 %~4 %~5 %~6 %~7 %~8
exit /b %errorlevel%

:: ─── Doctor (environment health checks) ─────────────────────────────────────
:cmd_doctor
cd /d "%PROJECT_DIR%"
bun run scripts/doctor.ts %~2 %~3 %~4 %~5 %~6 %~7 %~8
exit /b %errorlevel%

:: ─── Desktop (Tauri thin client) ────────────────────────────────────────────
:: Launch the Tauri desktop app. It is a thin CLIENT: it does NOT run its own
:: backend — it connects to whatever Octipus backend you point it at (local
:: `octi start`, a LAN host, or a remote deployment).
:cmd_desktop
set "DT_BUILD=false"
set "DT_STOP=false"
:desktop_parse
if "%~2"=="" goto :desktop_parsed
if /i "%~2"=="--build"      set "DT_BUILD=true"
if /i "%~2"=="-b"           set "DT_BUILD=true"
if /i "%~2"=="--stop"       set "DT_STOP=true"
if /i "%~2"=="--foreground" rem foreground is the only mode on Windows
if /i "%~2"=="-f"           rem foreground is the only mode on Windows
shift
goto :desktop_parse
:desktop_parsed

:: --stop: reap any running desktop app (built bundle or tauri dev).
if "!DT_STOP!"=="true" (
    echo   %BLUE%-%NC% Stopping desktop app...
    taskkill /F /IM "Octipus.exe" /T >nul 2>&1
    call :kill_port %DESKTOP_DEV_PORT%
    echo   %GREEN%v%NC% Reaped any running desktop processes.
    exit /b 0
)

:: Building the desktop client needs the Rust toolchain (cargo).
where cargo >nul 2>&1
if errorlevel 1 (
    echo   %RED%x%NC% Rust toolchain not found (cargo^) — required to build the desktop app.
    echo     %DIM%Install Rust from https://rustup.rs and the Tauri prerequisites.%NC%
    exit /b 1
)

:: Nudge the user to bring up a backend if nothing is reachable.
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if errorlevel 1 (
    echo     %DIM%No backend detected on :%API_PORT%. Start one with 'octi start',%NC%
    echo     %DIM%or point the app at a remote backend from its connection screen.%NC%
)

cd /d "%PROJECT_DIR%\web"
if "!DT_BUILD!"=="true" (
    echo   %BLUE%-%NC% Building the desktop app bundle %DIM%(can take a few minutes^)%NC%...
    echo     %DIM%Output: web\src-tauri\target\release\bundle\%NC%
    bun run tauri:build
    exit /b %errorlevel%
)

echo   %BLUE%-%NC% Launching the Octipus desktop app...
echo     %DIM%It connects to a backend (default http://localhost:%API_PORT%) — change it in-app.%NC%
bun run tauri:dev
exit /b %errorlevel%

:: ─── Uninstall ──────────────────────────────────────────────────────────────
:: Detect an Octipus Docker deployment (containers or volumes named octipus-*).
:: Sets HAS_DOCKER=true when found. Uses for/f so it only trips on real output.
:detect_docker
set "HAS_DOCKER=false"
where docker >nul 2>&1 || exit /b 0
if not exist "%PROJECT_DIR%\docker-compose.yml" exit /b 0
for /f "delims=" %%n in ('docker ps -a --format "{{.Names}}" 2^>nul ^| findstr /b "octipus-"') do set "HAS_DOCKER=true"
for /f "delims=" %%n in ('docker volume ls --format "{{.Name}}" 2^>nul ^| findstr "octipus-"') do set "HAS_DOCKER=true"
exit /b 0

:cmd_uninstall
set "PURGE=false"
set "ASSUME_YES=false"
set "DRY_RUN=false"
:uninstall_parse
if "%~2"=="" goto :uninstall_parsed
if /i "%~2"=="--purge"   set "PURGE=true"
if /i "%~2"=="--yes"     set "ASSUME_YES=true"
if /i "%~2"=="-y"        set "ASSUME_YES=true"
if /i "%~2"=="--dry-run" set "DRY_RUN=true"
if /i "%~2"=="-n"        set "DRY_RUN=true"
if /i "%~2"=="-h"        goto :cmd_uninstall_help
if /i "%~2"=="--help"    goto :cmd_uninstall_help
shift
goto :uninstall_parse
:uninstall_parsed

call :print_banner

:: Resolve the data dir: .env DATA_DIR overrides the default.
set "DATA_DIR_RESOLVED=%STATE_DIR%\data"
if exist "%PROJECT_DIR%\.env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b "DATA_DIR=" "%PROJECT_DIR%\.env" 2^>nul') do set "DATA_DIR_RESOLVED=%%b"
)
set "DATA_DIR_RESOLVED=!DATA_DIR_RESOLVED:"=!"
:: Expand a leading ~ to the user's home, matching the bash CLI.
if "!DATA_DIR_RESOLVED:~0,1!"=="~" set "DATA_DIR_RESOLVED=%USERPROFILE%!DATA_DIR_RESOLVED:~1!"

call :detect_docker

:: ── Show the plan ───────────────────────────────────────────────────────────
echo   %BOLD%This will remove Octipus from your system.%NC%
echo.
echo   %BLUE%-%NC% Stop running backend / web / TUI processes
if "!HAS_DOCKER!"=="true" (
    if "!PURGE!"=="true" (
        echo   %BLUE%-%NC% Docker: compose down %BOLD%-v%NC% ^(containers + volumes deleted^)
    ) else (
        echo   %BLUE%-%NC% Docker: compose down ^(containers only — named volumes kept^)
    )
)
if "!PURGE!"=="true" (
    echo   %BLUE%-%NC% Remove EVERYTHING under %STATE_DIR% ^(app state, vault, secrets^)
    echo   %YELLOW%^^!%NC% PURGE: your database, vault secrets and chat history will be %BOLD%permanently deleted%NC%.
) else (
    echo   %BLUE%-%NC% Keep your data: !DATA_DIR_RESOLVED!
    echo   %BLUE%-%NC% Back up secrets to %STATE_DIR%\.env.uninstall-backup
    echo     %DIM%Re-install later to reuse the same data. Pass --purge to wipe it all.%NC%
)
echo.

if "!DRY_RUN!"=="true" (
    echo   %GREEN%v%NC% Dry run — nothing was changed.
    exit /b 0
)

:: ── Confirm ─────────────────────────────────────────────────────────────────
if "!ASSUME_YES!"=="true" goto :uninstall_execute
set "WORD=uninstall"
if "!PURGE!"=="true" set "WORD=purge"
set "REPLY="
set /p "REPLY=  Type '!WORD!' to confirm: "
if not "!REPLY!"=="!WORD!" (
    echo.
    echo   %YELLOW%^^!%NC% Aborted — nothing was changed.
    exit /b 1
)
echo.

:uninstall_execute
:: Stop everything (frees ports, kills tracked + stray bun processes).
echo   %BLUE%-%NC% Stopping processes...
call :kill_all_octipus
echo   %GREEN%v%NC% Processes stopped

:: Tear down Docker if we detected an Octipus deployment.
if "!HAS_DOCKER!"=="true" (
    echo   %BLUE%-%NC% Tearing down Docker...
    pushd "%PROJECT_DIR%"
    if "!PURGE!"=="true" (
        docker compose down -v --remove-orphans >nul 2>&1 || echo   %YELLOW%^^!%NC% docker compose down failed — remove 'octipus-*' containers/volumes manually.
    ) else (
        docker compose down --remove-orphans >nul 2>&1 || echo   %YELLOW%^^!%NC% docker compose down failed — remove 'octipus-*' containers manually.
    )
    popd
    echo   %GREEN%v%NC% Docker torn down
)

:: Preserve secrets so kept data stays decryptable (MASTER_KEY lives in .env).
if not "!PURGE!"=="true" (
    if exist "%PROJECT_DIR%\.env" (
        copy /y "%PROJECT_DIR%\.env" "%STATE_DIR%\.env.uninstall-backup" >nul 2>&1 && (
            echo   %GREEN%v%NC% Secrets backed up to %STATE_DIR%\.env.uninstall-backup
        ) || (
            echo   %YELLOW%^^!%NC% Could not back up .env — kept data may be unreadable without its MASTER_KEY.
        )
    )
)

if "!PURGE!"=="true" (
    if exist "%STATE_DIR%" rmdir /s /q "%STATE_DIR%"
    echo   %GREEN%v%NC% Removed %STATE_DIR% ^(all data + secrets^)
) else (
    :: Only delete the app checkout when it's the installer-managed path;
    :: a dev clone or a linked global install is left in place.
    if /i "%PROJECT_DIR%"=="%STATE_DIR%\app" (
        rmdir /s /q "%PROJECT_DIR%"
        echo   %GREEN%v%NC% Removed app checkout %PROJECT_DIR%
    ) else (
        echo   %YELLOW%^^!%NC% App checkout at %PROJECT_DIR% looks like a dev clone — left in place.
        echo     %DIM%Delete it yourself if you want it gone.%NC%
    )
    if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%" >nul 2>&1
    if exist "%PID_FILE_WEB%" del "%PID_FILE_WEB%" >nul 2>&1
    if exist "%LOG_FILE%" del "%LOG_FILE%" >nul 2>&1
    if exist "%WEB_LOG_FILE%" del "%WEB_LOG_FILE%" >nul 2>&1
)

echo.
call :print_banner
if "!PURGE!"=="true" (
    echo   %GREEN%v%NC% Octipus fully removed. Goodbye. 🐙
) else (
    echo   %GREEN%v%NC% Octipus uninstalled — your data is preserved:
    echo     %DIM%data:    !DATA_DIR_RESOLVED!%NC%
    echo     %DIM%secrets: %STATE_DIR%\.env.uninstall-backup%NC%
)
echo.
echo   %BLUE%-%NC% Remove the %BOLD%octi%NC% command from your PATH with:
echo     %DIM%bun rm -g octipus%NC%
echo.
exit /b 0

:cmd_uninstall_help
call :print_banner
echo   %BOLD%octi uninstall%NC% — remove Octipus from this machine.
echo.
echo   By default your data is %BOLD%kept%NC% ^(database, vault, history^) so a
echo   later re-install picks up where you left off. Use --purge to wipe it.
echo.
echo   %BOLD%Usage:%NC% octi uninstall [--purge] [--yes] [--dry-run]
echo.
echo   %BOLD%Options:%NC%
echo     --purge          Also delete all data + secrets ^(%STATE_DIR%^) and Docker volumes
echo     --yes, -y        Skip the confirmation prompt
echo     --dry-run, -n    Show what would happen without changing anything
echo.
exit /b 0

:: ─── Help ───────────────────────────────────────────────────────────────────
:cmd_help
call :print_banner
echo   %BOLD%Usage:%NC% octi ^<command^> [options]
echo.
echo   %BOLD%Commands:%NC%
echo     setup            Run the first-run / re-config wizard
echo     start [--dev]    Start backend and web UI
echo     stop             Stop all Octipus processes
echo     restart [--dev]  Restart everything
echo     tui              Launch terminal chat — pins to current directory as project
echo     edit             Launch TUI editor — pins to current directory as project
echo     status           Show running state and service health
echo     doctor [--json]  Run environment health checks (what's wired, what's missing)
echo     logs [--web]     Tail backend logs (--web for web UI)
echo     open             Open web UI in browser
echo     desktop [opts]   Launch the desktop app ^(thin client; --build bundle, --stop quit^)
echo     uninstall        Remove Octipus ^(keeps data; --purge wipes everything^)
echo     help             Show this help message
echo.
echo   %BOLD%Options:%NC%
echo     --dev, -d        Start in development mode (hot reload)
echo     --web, -w        Show web UI logs instead of backend
echo.
echo   %BOLD%Environment:%NC%
echo     API_PORT         Backend API port %DIM%(default: 3005)%NC%
echo     WEB_PORT         Web UI port %DIM%(default: 3007)%NC%
echo.
exit /b 0
