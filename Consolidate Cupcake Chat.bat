@echo off
setlocal
where pwsh.exe >nul 2>nul
if %errorlevel% equ 0 (set "CUPCAKE_POWERSHELL=pwsh.exe") else (set "CUPCAKE_POWERSHELL=powershell.exe")
"%CUPCAKE_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\consolidate-workspace.ps1" -Apply
if errorlevel 1 (echo Consolidation stopped. Original data has been retained for any unfinished step.)
pause
