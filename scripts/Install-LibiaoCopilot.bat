@echo off
title Libiao Copilot Installer
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0Install-LibiaoCopilot.ps1"
if errorlevel 1 (
    echo.
    echo Installation failed. See error message above.
    pause
)
