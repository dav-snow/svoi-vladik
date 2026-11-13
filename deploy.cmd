@echo off
rem One-click deploy for the demo. Double-click; domain can be empty (uses sslip.io).
rem Requires: SSH key access to the server and Docker already installed there.
setlocal

set HOST=176.53.253.60
set USER_NAME=tech
set WSL_REPO=/home/kosty/svoi-vladik
set DEFAULT_DOMAIN=176-53-253-60.sslip.io

set DOMAIN=%~1
if "%DOMAIN%"=="" set /p DOMAIN=Домен для HTTPS [Enter = %DEFAULT_DOMAIN%]: 
if "%DOMAIN%"=="" set DOMAIN=%DEFAULT_DOMAIN%

echo.
echo === Проверяю соединение с %USER_NAME%@%HOST% ===
wsl bash -lc "ssh -o BatchMode=yes -o ConnectTimeout=10 %USER_NAME%@%HOST% true"
if errorlevel 1 (
  echo.
  echo Нет доступа по SSH-ключу с этой машины.
  echo Ключ лежит у того, кто деплоит: он запускает deploy из своей копии репозитория.
  pause
  exit /b 1
)

echo.
echo === Деплой на https://%DOMAIN% ===
wsl bash "%WSL_REPO%/scripts/deploy-remote.sh" %USER_NAME% %HOST% %DOMAIN%

if errorlevel 1 (
  echo.
  echo Деплой не завершился. Смотрите сообщения выше.
) else (
  echo.
  echo Готово: https://%DOMAIN%/
)
pause
