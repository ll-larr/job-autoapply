@echo off
chcp 65001 >nul
title Panel otklikov
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts/panel.ps1"
pause
