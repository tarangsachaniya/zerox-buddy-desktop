@echo off
rem Double-click to remove Zerox Buddy. Keep this next to Uninstall-Zerox-Buddy.ps1.
setlocal
echo.
set /p REMOVE_DATA=Also delete Zerox Buddy's saved data (sign-in, settings, this computer's ID)? [y/N]
set ARGS=
if /i "%REMOVE_DATA%"=="y" set ARGS=-RemoveUserData
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-Zerox-Buddy.ps1" %ARGS%
echo.
pause
