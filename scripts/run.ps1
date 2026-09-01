# Повседневный запуск конвейера: проверки окружения, поиск, панель одобрения.
#
# Отправки здесь НЕТ намеренно. Подача откликов от имени пользователя —
# необратимое действие вовне, и она остаётся отдельной командой, которую надо
# набрать осознанно, а не побочным эффектом двойного клика по ярлыку.
#
# Запуск: правый клик по Запустить.cmd, либо npm run go

param(
    [string]$Query = "бизнес-аналитик",
    [int]$Limit = 6,
    [switch]$SkipSearch
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   $text" -ForegroundColor DarkGray }
function Bad($text)  { Write-Host "   $text" -ForegroundColor Yellow }

Write-Host "Конвейер откликов" -ForegroundColor White

# --- 1. Ключ ------------------------------------------------------------
# Читаем из User-области, а не только из текущего процесса: переменная,
# выставленная через SetEnvironmentVariable, не видна в уже открытых
# терминалах, и это регулярно выглядит как "ключ пропал".
Step "Ключ OpenRouter"
if (-not $env:OPENROUTER_API_KEY) {
    $env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
}
if (-not $env:OPENROUTER_API_KEY) {
    Bad "не найден."
    Bad "Письма будут пустыми: вакансии попадут в очередь, но текст придётся писать руками."
    Bad "Завести бесплатный ключ: https://openrouter.ai/keys, затем один раз выполнить:"
    Write-Host '   [Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY","sk-or-v1-...","User")' -ForegroundColor DarkGray
} else {
    Ok "найден ($($env:OPENROUTER_API_KEY.Length) символов)"
}

# --- 2. Прокси ----------------------------------------------------------
# Node не ходит через HTTP_PROXY сам, поэтому в npm-скриптах стоит
# --use-env-proxy. Но флаг лишь РАЗРЕШАЕТ читать переменные — сами переменные
# должны существовать, а в User- и Machine-области их нет. Поэтому задаём их
# здесь, для запускаемого процесса: иначе панель стартует с флагом, честно
# считает себя проксированной и всё равно упирается в блок-страницу
# провайдера. Ровно это и случилось 2026-09-01 — 22 письма ушли в пустоту.
Step "Прокси"
$proxyUp = $null -ne (Get-NetTCPConnection -LocalPort 10801 -State Listen -ErrorAction SilentlyContinue)
if ($proxyUp) {
    if (-not $env:HTTP_PROXY)  { $env:HTTP_PROXY  = "http://127.0.0.1:10801" }
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = "http://127.0.0.1:10801" }
    Ok "127.0.0.1:10801 слушает; HTTP_PROXY/HTTPS_PROXY заданы для этого запуска"
} else {
    Bad "на 127.0.0.1:10801 никто не слушает."
    Bad "Запросы к OpenRouter и hr.ge упрутся в блокировку провайдера: письма выйдут пустыми."
    Bad "Запусти клиент прокси (xray) и повтори."
}

# --- 3. Залипший браузер ------------------------------------------------
# launchPersistentContext держит каталог профиля эксклюзивно. Прерванный
# прогон оставляет Chromium висеть, и следующий падает с "профиль занят" —
# сообщение, по которому причина не угадывается.
Step "Браузерный профиль"
$stale = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ms-playwright*" }
if ($stale) {
    Bad "остались процессы Chromium от прошлого прогона: $($stale.Count). Закрываю."
    $stale | Stop-Process -Force
    Start-Sleep -Seconds 2
    Ok "профиль освобождён"
} else {
    Ok "свободен"
}

# --- 4. Поиск -----------------------------------------------------------
if (-not $SkipSearch) {
    Step "Поиск: «$Query», не больше $Limit вакансий"
    Ok "откроется браузер, страницы только читаются, ничего не отправляется"
    npm run search -- $Query --limit $Limit
    if ($LASTEXITCODE -ne 0) {
        Bad "поиск завершился с ошибкой. Панель всё равно открою: в очереди может лежать прошлое."
    }
} else {
    Step "Поиск пропущен (--SkipSearch)"
}

# --- 5. Панель ----------------------------------------------------------
Step "Панель одобрения"
Ok "открой http://127.0.0.1:4321 — прочитай письма, поправь, одобри нужные"
Ok "после этого отправка отдельной командой:  npm run send"
Ok "остановить панель: Ctrl+C"
Start-Process "http://127.0.0.1:4321"
npm run panel
