@echo off
cd /d "%~dp0.."
node scripts/notify-wxmp.js
echo Exit code: %ERRORLEVEL%
pause
