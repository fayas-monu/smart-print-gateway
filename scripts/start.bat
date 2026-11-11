@echo off
title Smart Print Gateway
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found on this computer.
  echo  Install the LTS build from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
echo.
echo  Starting Smart Print Gateway...
echo  Customer portal:  http://localhost:4173
echo  Operator console: http://localhost:4173/dashboard
echo.
node server.js --open
pause
