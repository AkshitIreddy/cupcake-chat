@echo off
setlocal
set "CUPCAKE_ARCHIVE_SCRIPT=%~dp0scripts\cleanup-cupcake-e-drive.ps1"
start "" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%CUPCAKE_ARCHIVE_SCRIPT%"
endlocal
exit /b 0
