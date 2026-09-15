@echo off
setlocal
node "%~dp0scripts\clean-workspace.mjs" --apply
if errorlevel 1 (echo Cleanup stopped. Review the message above.)
pause
