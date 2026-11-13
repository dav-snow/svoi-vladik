@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where.exe node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or newer was not found.
  echo Install Node.js from nodejs.org, then run this file again.
  pause
  exit /b 1
)
node "%~dp0scripts\start.mjs" %*
set "SV_START_EXIT=%ERRORLEVEL%"
if not "%SV_START_EXIT%"=="0" pause
exit /b %SV_START_EXIT%
