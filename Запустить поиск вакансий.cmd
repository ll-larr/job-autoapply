@echo off
chcp 65001 >nul
title Konveier otklikov
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts/run.ps1" %*
pause
