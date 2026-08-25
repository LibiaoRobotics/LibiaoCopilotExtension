@echo off
title Libiao Copilot Installer
where pwsh.exe >nul 2>&1
if %errorlevel% equ 0 (
    pwsh.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0Install-LibiaoCopilot.ps1" %*
) else (
    powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0Install-LibiaoCopilot.ps1" %*
)
if errorlevel 1 (
    echo.
    echo Installation failed. See error message above.
    pause
)
