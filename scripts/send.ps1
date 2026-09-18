# Отправка одобренных откликов.
#
# Отдельный файл и отдельный ярлык, а не флаг у Запустить.cmd. Подача отклика
# от имени пользователя необратима: hh.ru не даёт её отменить, работодатель
# видит её сразу. Такое действие не должно случаться побочным эффектом
# двойного клика по ярлыку с названием «Запустить».
#
# Здесь же стоит подтверждение: перед отправкой показывается, сколько заявок и
# куда уйдёт, и требуется ввести «да».

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $env:OPENROUTER_API_KEY) {
    $env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
}

# Залипший Chromium от прерванного прогона держит профиль и роняет подачу.
$stale = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ms-playwright*" }
if ($stale) {
    Write-Host "Закрываю $($stale.Count) процессов Chromium от прошлого прогона..." -ForegroundColor DarkGray
    $stale | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "ОТПРАВКА ОТКЛИКОВ" -ForegroundColor White
Write-Host "Это необратимо: отклик на hh.ru нельзя отозвать, работодатель увидит его сразу." -ForegroundColor Yellow
Write-Host ""

npm run status

Write-Host ""
$answer = Read-Host "Отправить всё, что в статусе approved? Введи «да» для подтверждения"
if ($answer -ne "да" -and $answer -ne "da") {
    Write-Host "Отменено. Ничего не отправлено." -ForegroundColor DarkGray
    exit 0
}

npm run send
