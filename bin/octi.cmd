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

:: ─── Assistant CLI (Windows) ────────────────────────────────────────────────
:: Single-command management for the Assistant application.
::
:: Usage:
::   assistant start [--dev]    Start backend + web UI
::   assistant stop             Stop all assistant processes
::   assistant restart [--dev]  Restart everything
::   assistant status           Show running state
::   assistant logs             Tail backend logs
::   assistant open             Open web UI in browser
:: ────────────────────────────────────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_DIR=%%~fI"

set "STATE_DIR=%USERPROFILE%\.assistant"
set "PID_FILE_BACKEND=%STATE_DIR%\backend.pid"
set "PID_FILE_WEB=%STATE_DIR%\web.pid"
set "LOG_FILE=%STATE_DIR%\backend.log"
set "WEB_LOG_FILE=%STATE_DIR%\web.log"

if not defined API_PORT set "API_PORT=3005"
if not defined WEB_PORT set "WEB_PORT=3007"

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

if "%COMMAND%"=="start" goto :cmd_start
if "%COMMAND%"=="stop" goto :cmd_stop
if "%COMMAND%"=="restart" goto :cmd_restart
if "%COMMAND%"=="status" goto :cmd_status
if "%COMMAND%"=="logs" goto :cmd_logs
if "%COMMAND%"=="open" goto :cmd_open
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
echo   ^|         A S S I S T A N T         ^|
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

:kill_all_assistant
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
powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"Name='bun.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*the_assistant*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
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
call :kill_all_assistant
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

    call :check_port 6379
    if errorlevel 1 (
        echo   %RED%x%NC% Redis not reachable on port 6379
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d redis%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% Redis is reachable
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
        echo   %YELLOW%!%NC% Production build failed, using dev mode instead
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
echo   %GREEN%%BOLD%Assistant is running!%NC%
echo.
echo   Web UI:    %CYAN%http://localhost:%WEB_PORT%%NC%
echo   API:       %CYAN%http://localhost:%API_PORT%%NC%
echo   API Docs:  %CYAN%http://localhost:%API_PORT%/swagger%NC%
echo.
echo   %BOLD%Commands:%NC%
echo   assistant status    Show running state
echo   assistant logs      View backend logs
echo   assistant stop      Stop everything
echo.
exit /b 0

:start_health_timeout
echo   %RED%x%NC% Backend health check timed out (60s^)
echo     %DIM%Check logs: assistant logs%NC%
:: Kill the backend we started since it didn't come up
call :kill_port %API_PORT%
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
exit /b 1

:: ─── Stop ───────────────────────────────────────────────────────────────────
:cmd_stop
call :print_banner

echo   %BLUE%-%NC% Stopping assistant...
call :kill_all_assistant

echo   %GREEN%v%NC% Assistant stopped
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
call :kill_all_assistant
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

    call :check_port 6379
    if errorlevel 1 (
        echo   %RED%x%NC% Redis not reachable on port 6379
        echo     %DIM%Start it: cd ~/docker-services ^&^& docker compose up -d redis%NC%
        exit /b 1
    )
    echo   %GREEN%v%NC% Redis is reachable
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
        echo   %YELLOW%!%NC% Production build failed, using dev mode instead
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
echo   %GREEN%%BOLD%Assistant is running!%NC%
echo.
echo   Web UI:    %CYAN%http://localhost:%WEB_PORT%%NC%
echo   API:       %CYAN%http://localhost:%API_PORT%%NC%
echo   API Docs:  %CYAN%http://localhost:%API_PORT%/swagger%NC%
echo.
exit /b 0

:restart_health_timeout
echo   %RED%x%NC% Backend health check timed out (60s^)
echo     %DIM%Check logs: assistant logs%NC%
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

    call :check_port 6379
    if errorlevel 1 (
        echo   %RED%x%NC% Redis: not reachable
    ) else (
        echo   %GREEN%v%NC% Redis: reachable %DIM%(port 6379^)%NC%
    )
) else (
    echo   %GREEN%v%NC% PGlite:     embedded database
    echo   %GREEN%v%NC% Cache:      in-memory
)

call :check_port 11434
if errorlevel 1 (
    echo   %YELLOW%!%NC% Ollama:     not reachable %DIM%(optional^)%NC%
) else (
    echo   %GREEN%v%NC% Ollama:     reachable %DIM%(port 11434^)%NC%
)

call :check_port 4000
if errorlevel 1 (
    echo   %YELLOW%!%NC% LiteLLM:    not reachable %DIM%(optional^)%NC%
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
        echo   %RED%x%NC% No web log file found. Start the assistant first.
    )
) else (
    if exist "%LOG_FILE%" (
        type "%LOG_FILE%"
        echo.
        echo   %DIM%[Watching %LOG_FILE%]%NC%
        powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   %RED%x%NC% No log file found. Start the assistant first.
    )
)
exit /b 0

:: ─── Open ───────────────────────────────────────────────────────────────────
:cmd_open
start "" "http://localhost:%WEB_PORT%"
echo   %GREEN%v%NC% Opening %CYAN%http://localhost:%WEB_PORT%%NC%
exit /b 0

:: ─── Help ───────────────────────────────────────────────────────────────────
:cmd_help
call :print_banner
echo   %BOLD%Usage:%NC% assistant ^<command^> [options]
echo.
echo   %BOLD%Commands:%NC%
echo     start [--dev]    Start backend and web UI
echo     stop             Stop all assistant processes
echo     restart [--dev]  Restart everything
echo     status           Show running state and service health
echo     logs [--web]     Tail backend logs (--web for web UI)
echo     open             Open web UI in browser
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
