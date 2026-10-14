@echo off
title SourceBox - public link
cd /d "%~dp0"
echo.
echo   Pehle "Start Vault.bat" chalu hona chahiye (dusri window me).
echo.
node scripts\tunnel.js
echo.
pause >nul
