@echo off
rem AL SHAJAR STATIONERY - Smart Print Gateway (Windows)
rem Starts the print gateway on the LAN interface. Print mode: simulate.
setlocal
cd /d "%~dp0.."
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" server.js %*
exit /b %ERRORLEVEL%
