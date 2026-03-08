@echo off
setlocal enabledelayedexpansion

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

echo   [ERROR] Unknown command: %COMMAND%
echo.
goto :cmd_help

:: ─── Helpers ────────────────────────────────────────────────────────────────

:kill_port
:: Kill all processes listening on a given port
:: Usage: call :kill_port 3005
set "_PORT=%~1"
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%_PORT% " ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
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
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.

:: Kill any existing processes first (clean slate)
call :kill_all_assistant
timeout /t 1 /nobreak >nul

:: Check bun
where bun >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] bun is not installed. Install from https://bun.sh
    exit /b 1
)

set "DEV_MODE=false"
if "%~2"=="--dev" set "DEV_MODE=true"
if "%~2"=="-d" set "DEV_MODE=true"

:: Check required services (only for external storage mode)
if "!STORAGE_MODE!"=="external" (
    echo   [..] Checking services...
    call :check_port 5432
    if errorlevel 1 (
        echo   [ERROR] PostgreSQL not reachable on port 5432
        echo          Start it: cd ~/docker-services ^&^& docker compose up -d db
        exit /b 1
    )
    echo   [OK] PostgreSQL is reachable

    call :check_port 6379
    if errorlevel 1 (
        echo   [ERROR] Redis not reachable on port 6379
        echo          Start it: cd ~/docker-services ^&^& docker compose up -d redis
        exit /b 1
    )
    echo   [OK] Redis is reachable
) else (
    echo   [OK] Embedded mode (PGlite + in-memory cache^)
)

:: Start backend
if "!DEV_MODE!"=="true" (
    echo   [..] Starting backend (dev mode with hot reload^)...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run dev" "%LOG_FILE%"
) else (
    echo   [..] Starting backend...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run start" "%LOG_FILE%"
)

:: Wait for backend to be healthy BEFORE starting web UI
echo   [..] Waiting for backend to be ready...
set "ATTEMPTS=0"
:start_health_loop
if !ATTEMPTS! geq 60 goto :start_health_timeout
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 goto :start_health_ok
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
goto :start_health_loop

:start_health_ok
echo   [OK] Backend is ready on port %API_PORT%

:: Clear Next.js cache so code changes take effect
echo   [..] Clearing web UI cache...
if exist "%PROJECT_DIR%\web\.next" rmdir /s /q "%PROJECT_DIR%\web\.next"
if exist "%PROJECT_DIR%\web\node_modules\.cache" rmdir /s /q "%PROJECT_DIR%\web\node_modules\.cache"

:: Start web UI only after backend is confirmed healthy
if "!DEV_MODE!"=="true" (
    echo   [..] Starting web UI (dev mode^)...
    call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
) else (
    echo   [..] Building web UI...
    cd /d "%PROJECT_DIR%\web"
    call bun run build >"%WEB_LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo   [WARN] Production build failed, using dev mode instead
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
    ) else (
        echo   [..] Starting web UI...
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run start" "%WEB_LOG_FILE%" append
    )
)

timeout /t 2 /nobreak >nul
echo   [OK] Web UI starting on port %WEB_PORT%

:: Open browser
start "" "http://localhost:%WEB_PORT%"

echo.
echo   Assistant is running!
echo.
echo   Web UI:    http://localhost:%WEB_PORT%
echo   API:       http://localhost:%API_PORT%
echo   API Docs:  http://localhost:%API_PORT%/swagger
echo.
exit /b 0

:start_health_timeout
echo   [ERROR] Backend health check timed out (60s^)
echo   [..] Check logs: assistant logs
:: Kill the backend we started since it didn't come up
call :kill_port %API_PORT%
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
exit /b 1

:: ─── Stop ───────────────────────────────────────────────────────────────────
:cmd_stop
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.

echo   [..] Stopping assistant...
call :kill_all_assistant

echo   [OK] Assistant stopped
echo.
exit /b 0

:: ─── Restart ────────────────────────────────────────────────────────────────
:cmd_restart
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.

set "DEV_MODE=false"
if "%~2"=="--dev" set "DEV_MODE=true"
if "%~2"=="-d" set "DEV_MODE=true"

:: ── 1. STOP ─────────────────────────────────────────────────────────────────
echo   [..] Stopping all processes...
call :kill_all_assistant
timeout /t 2 /nobreak >nul
echo   [OK] Processes stopped

:: ── 2. CLEAR CACHES ─────────────────────────────────────────────────────────
echo   [..] Clearing caches...
if exist "%PROJECT_DIR%\web\.next" rmdir /s /q "%PROJECT_DIR%\web\.next"
if exist "%PROJECT_DIR%\web\node_modules\.cache" rmdir /s /q "%PROJECT_DIR%\web\node_modules\.cache"
echo   [OK] Caches cleared
echo.

:: ── 3. START ─────────────────────────────────────────────────────────────────

:: Check bun
where bun >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] bun is not installed. Install from https://bun.sh
    exit /b 1
)

:: Check required services (only for external storage mode)
if "!STORAGE_MODE!"=="external" (
    echo   [..] Checking services...
    call :check_port 5432
    if errorlevel 1 (
        echo   [ERROR] PostgreSQL not reachable on port 5432
        echo          Start it: cd ~/docker-services ^&^& docker compose up -d db
        exit /b 1
    )
    echo   [OK] PostgreSQL is reachable

    call :check_port 6379
    if errorlevel 1 (
        echo   [ERROR] Redis not reachable on port 6379
        echo          Start it: cd ~/docker-services ^&^& docker compose up -d redis
        exit /b 1
    )
    echo   [OK] Redis is reachable
) else (
    echo   [OK] Embedded mode (PGlite + in-memory cache^)
)

:: Start backend
if "!DEV_MODE!"=="true" (
    echo   [..] Starting backend (dev mode with hot reload^)...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run dev" "%LOG_FILE%"
) else (
    echo   [..] Starting backend...
    call :start_hidden "backend" "%PROJECT_DIR%" "bun run start" "%LOG_FILE%"
)

:: Wait for backend to be healthy BEFORE starting web UI
echo   [..] Waiting for backend to be ready...
set "ATTEMPTS=0"
:restart_health_loop
if !ATTEMPTS! geq 60 goto :restart_health_timeout
curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 goto :restart_health_ok
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
goto :restart_health_loop

:restart_health_ok
echo   [OK] Backend is ready on port %API_PORT%

:: Start web UI (cache already cleared above)
if "!DEV_MODE!"=="true" (
    echo   [..] Starting web UI (dev mode^)...
    call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
) else (
    echo   [..] Building web UI...
    cd /d "%PROJECT_DIR%\web"
    call bun run build >"%WEB_LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo   [WARN] Production build failed, using dev mode instead
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run dev" "%WEB_LOG_FILE%"
    ) else (
        echo   [..] Starting web UI...
        call :start_hidden "webui" "%PROJECT_DIR%\web" "bun run start" "%WEB_LOG_FILE%" append
    )
)

timeout /t 2 /nobreak >nul
echo   [OK] Web UI starting on port %WEB_PORT%

:: Open browser
start "" "http://localhost:%WEB_PORT%"

echo.
echo   Assistant is running!
echo.
echo   Web UI:    http://localhost:%WEB_PORT%
echo   API:       http://localhost:%API_PORT%
echo   API Docs:  http://localhost:%API_PORT%/swagger
echo.
exit /b 0

:restart_health_timeout
echo   [ERROR] Backend health check timed out (60s^)
echo   [..] Check logs: assistant logs
:: Kill the backend we started since it didn't come up
call :kill_port %API_PORT%
if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
exit /b 1

:: ─── Status ─────────────────────────────────────────────────────────────────
:cmd_status
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.
echo   Process Status
echo.

curl -sf http://localhost:%API_PORT%/api/health >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Backend: running on port %API_PORT%
) else (
    echo   [--] Backend: not running
)

curl -sf http://localhost:%WEB_PORT% >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Web UI:  running on port %WEB_PORT%
) else (
    echo   [--] Web UI:  not running
)

echo.
echo   Service Status (!STORAGE_MODE! mode^)
echo.

if "!STORAGE_MODE!"=="external" (
    call :check_port 5432
    if errorlevel 1 (
        echo   [--] PostgreSQL: not reachable
    ) else (
        echo   [OK] PostgreSQL: reachable (port 5432^)
    )

    call :check_port 6379
    if errorlevel 1 (
        echo   [--] Redis: not reachable
    ) else (
        echo   [OK] Redis: reachable (port 6379^)
    )
) else (
    echo   [OK] PGlite: embedded database
    echo   [OK] Cache: in-memory
)

call :check_port 11434
if errorlevel 1 (
    echo   [--] Ollama: not reachable (optional^)
) else (
    echo   [OK] Ollama: reachable (port 11434^)
)

call :check_port 4000
if errorlevel 1 (
    echo   [--] LiteLLM: not reachable (optional^)
) else (
    echo   [OK] LiteLLM: reachable (port 4000^)
)

echo.
echo   URLs
echo   Web UI:    http://localhost:%WEB_PORT%
echo   API:       http://localhost:%API_PORT%
echo   API Docs:  http://localhost:%API_PORT%/swagger
echo.
exit /b 0

:: ─── Logs ───────────────────────────────────────────────────────────────────
:cmd_logs
if "%~2"=="--web" (
    if exist "%WEB_LOG_FILE%" (
        type "%WEB_LOG_FILE%"
        echo.
        echo   [Watching %WEB_LOG_FILE%]
        powershell -NoProfile -Command "Get-Content '%WEB_LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   [ERROR] No web log file found. Start the assistant first.
    )
) else (
    if exist "%LOG_FILE%" (
        type "%LOG_FILE%"
        echo.
        echo   [Watching %LOG_FILE%]
        powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   [ERROR] No log file found. Start the assistant first.
    )
)
exit /b 0

:: ─── Open ───────────────────────────────────────────────────────────────────
:cmd_open
start "" "http://localhost:%WEB_PORT%"
echo   [OK] Opening http://localhost:%WEB_PORT%
exit /b 0

:: ─── Help ───────────────────────────────────────────────────────────────────
:cmd_help
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.
echo   Usage: assistant ^<command^> [options]
echo.
echo   Commands:
echo     start [--dev]    Start backend and web UI
echo     stop             Stop all assistant processes
echo     restart [--dev]  Restart everything
echo     status           Show running state and service health
echo     logs [--web]     Tail backend logs (--web for web UI)
echo     open             Open web UI in browser
echo     help             Show this help message
echo.
echo   Options:
echo     --dev, -d        Start in development mode (hot reload)
echo     --web, -w        Show web UI logs instead of backend
echo.
exit /b 0
