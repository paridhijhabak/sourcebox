@echo off
title Asset Vault
cd /d "%~dp0"
echo.
echo   Asset Vault start ho raha hai...
echo   Is window ko band mat kijiye.
echo.
start "" http://localhost:4477

:run
node server.js
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto done
echo.
echo   [%DATE% %TIME%] server exit code %CODE%, 3 second me restart... >> crash.log
echo   Server ruk gaya (code %CODE%). 3 second me apne aap restart hoga.
echo   Rokna ho to abhi Ctrl+C dabaayiye.
timeout /t 3 /nobreak >nul
goto run

:done
echo.
echo   Server band ho gaya. Koi bhi key dabaayiye.
pause >nul
