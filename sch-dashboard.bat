@echo off
setlocal EnableDelayedExpansion
title SCH Loop - Dashboard Control
set "HERE=%~dp0"
set "PORT=4600"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "AUTOFILE=%STARTUP%\SCH-Loop-Dashboard.vbs"

:menu
cls
call :status
echo ===============================================
echo    SCH LOOP - DASHBOARD CONTROL
echo ===============================================
echo.
echo    Status      : !STATUS!
echo    Auto-start  : !AUTO!
echo    URL         : http://localhost:%PORT%
echo    Tailscale   : http://10.10.10.10:%PORT%
echo.
echo -----------------------------------------------
echo    [1] Start dashboard
echo    [2] Stop dashboard
echo    [3] Restart dashboard
echo    [4] Enable  auto-start (at login)
echo    [5] Disable auto-start
echo    [6] Open dashboard in browser
echo    [0] Exit
echo -----------------------------------------------
echo.
set "CH="
set /p "CH=Choose: "
if "!CH!"=="1" goto start
if "!CH!"=="2" goto stop
if "!CH!"=="3" goto restart
if "!CH!"=="4" goto enable
if "!CH!"=="5" goto disable
if "!CH!"=="6" goto open
if "!CH!"=="0" goto end
goto menu

:status
set "STATUS=STOPPED"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING" 2^>nul') do set "STATUS=RUNNING (pid %%a)"
if exist "%AUTOFILE%" (set "AUTO=ENABLED") else (set "AUTO=DISABLED")
exit /b

:start
call :status
echo !STATUS! | findstr /C:"RUNNING" >nul && (echo. & echo Already running. & pause & goto menu)
echo Starting dashboard...
wscript.exe "%HERE%sch-dashboard-hidden.vbs"
timeout /t 2 /nobreak >nul
call :status
echo   -^> !STATUS!
pause
goto menu

:stop
echo Stopping dashboard...
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING" 2^>nul') do (
  taskkill /PID %%a /F >nul 2>&1
  set "FOUND=1"
)
if defined FOUND (echo   -^> stopped.) else (echo   -^> was not running.)
timeout /t 1 /nobreak >nul
pause
goto menu

:restart
call :stopquiet
timeout /t 1 /nobreak >nul
wscript.exe "%HERE%sch-dashboard-hidden.vbs"
timeout /t 2 /nobreak >nul
call :status
echo Restarted -^> !STATUS!
pause
goto menu

:stopquiet
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING" 2^>nul') do taskkill /PID %%a /F >nul 2>&1
exit /b

:enable
> "%AUTOFILE%" echo ' SCH Loop dashboard - auto-start at login. Delete this file to disable.
>> "%AUTOFILE%" echo Set sh = CreateObject("WScript.Shell"^)
>> "%AUTOFILE%" echo sh.CurrentDirectory = "%HERE:~0,-1%"
>> "%AUTOFILE%" echo sh.Run "node scripts\dashboard.mjs", 0, False
echo.
echo Auto-start ENABLED.
echo   %AUTOFILE%
echo The dashboard will start automatically when you log in.
pause
goto menu

:disable
if exist "%AUTOFILE%" (
  del /f /q "%AUTOFILE%"
  echo. & echo Auto-start DISABLED.
) else (
  echo. & echo Auto-start was already disabled.
)
pause
goto menu

:open
start "" "http://localhost:%PORT%"
goto menu

:end
endlocal
