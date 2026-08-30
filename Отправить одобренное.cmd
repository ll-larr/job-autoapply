@echo off
chcp 65001 >nul
title Otpravka odobrennykh otklikov
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts/send.ps1"
pause
