@echo off
rem Restart the agentd daemon so it runs the current code. It refuses (and changes nothing) while a task is running.
cd /d "%~dp0packages\agentd"
node tools\restart-daemon.mjs
echo.
pause
