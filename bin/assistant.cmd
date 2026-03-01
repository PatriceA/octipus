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

:: ─── Start ───────────────────────────────────────────────────────────────────
:cmd_start
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.

:: Check bun
where bun >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] bun is not installed. Install from https://bun.sh
    exit /b 1
)

set "DEV_MODE=false"
if "%~2"=="--dev" set "DEV_MODE=true"
if "%~2"=="-d" set "DEV_MODE=true"

:: Start backend
echo   Starting backend...
cd /d "%PROJECT_DIR%"
if "%DEV_MODE%"=="true" (
    start /b "" cmd /c "bun run dev > "%LOG_FILE%" 2>&1"
) else (
    start /b "" cmd /c "bun run start > "%LOG_FILE%" 2>&1"
)

:: Get backend PID (approximate via wmic)
timeout /t 2 /nobreak >nul
for /f "tokens=2" %%a in ('tasklist /fi "windowtitle eq bun" /fo list 2^>nul ^| find "PID"') do (
    echo %%a > "%PID_FILE_BACKEND%"
)

:: Start web UI
echo   Starting web UI...
cd /d "%PROJECT_DIR%\web"
if "%DEV_MODE%"=="true" (
    start /b "" cmd /c "bun run dev > "%WEB_LOG_FILE%" 2>&1"
) else (
    start /b "" cmd /c "bun run start > "%WEB_LOG_FILE%" 2>&1"
)

:: Wait for health
echo   Waiting for backend...
set "ATTEMPTS=0"
:health_loop
if %ATTEMPTS% geq 30 goto :health_timeout
curl -sf http://localhost:%API_PORT%/health >nul 2>&1
if not errorlevel 1 goto :health_ok
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
goto :health_loop

:health_ok
echo   [OK] Backend is ready
goto :start_done

:health_timeout
echo   [WARN] Backend health check timed out

:start_done
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

:: ─── Stop ────────────────────────────────────────────────────────────────────
:cmd_stop
echo.
echo   Stopping assistant...

:: Kill bun processes for this project
taskkill /f /fi "WINDOWTITLE eq bun*" >nul 2>&1
taskkill /f /im "bun.exe" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq next*" >nul 2>&1

if exist "%PID_FILE_BACKEND%" del "%PID_FILE_BACKEND%"
if exist "%PID_FILE_WEB%" del "%PID_FILE_WEB%"

echo   [OK] Assistant stopped
echo.
exit /b 0

:: ─── Restart ─────────────────────────────────────────────────────────────────
:cmd_restart
call :cmd_stop
call :cmd_start %2
exit /b 0

:: ─── Status ──────────────────────────────────────────────────────────────────
:cmd_status
echo.
echo   ╔═══════════════════════════════════╗
echo   ║         A S S I S T A N T         ║
echo   ╚═══════════════════════════════════╝
echo.
echo   Process Status
echo.

curl -sf http://localhost:%API_PORT%/health >nul 2>&1
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
echo   URLs
echo   Web UI:    http://localhost:%WEB_PORT%
echo   API:       http://localhost:%API_PORT%
echo   API Docs:  http://localhost:%API_PORT%/swagger
echo.
exit /b 0

:: ─── Logs ────────────────────────────────────────────────────────────────────
:cmd_logs
if "%~2"=="--web" (
    if exist "%WEB_LOG_FILE%" (
        type "%WEB_LOG_FILE%"
        echo.
        echo   [Watching %WEB_LOG_FILE%]
        powershell -Command "Get-Content '%WEB_LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   [ERROR] No web log file found. Start the assistant first.
    )
) else (
    if exist "%LOG_FILE%" (
        type "%LOG_FILE%"
        echo.
        echo   [Watching %LOG_FILE%]
        powershell -Command "Get-Content '%LOG_FILE%' -Wait -Tail 50"
    ) else (
        echo   [ERROR] No log file found. Start the assistant first.
    )
)
exit /b 0

:: ─── Open ────────────────────────────────────────────────────────────────────
:cmd_open
start "" "http://localhost:%WEB_PORT%"
echo   [OK] Opening http://localhost:%WEB_PORT%
exit /b 0

:: ─── Help ────────────────────────────────────────────────────────────────────
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
echo     status           Show running state
echo     logs [--web]     Tail backend logs (--web for web UI)
echo     open             Open web UI in browser
echo     help             Show this help message
echo.
echo   Options:
echo     --dev, -d        Start in development mode (hot reload)
echo     --web, -w        Show web UI logs instead of backend
echo.
exit /b 0
