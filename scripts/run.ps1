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
# Прокси нужен РОВНО ОДНОМУ адресату — OpenRouter: провайдер блокирует прямые
# запросы к нему и отдаёт 403 «Access denied by security policy». Все площадки,
# наоборот, через прокси НЕ РАБОТАЮТ: careerist.ru даёт ConnectTimeout (3 из 3
# проверок), hh.ru отвечает 403. Их выход за границу им не нравится.
#
# Поэтому маршрутизация раздельная: NO_PROXY уводит площадки напрямую, а всё
# остальное (то есть OpenRouter) идёт через прокси. Проверено живьём
# 2026-09-01: с этой парой переменных все четыре адресата отвечают 200
# одновременно, чего не даёт ни «всё через прокси», ни «всё напрямую».
#
# Node не читает эти переменные без --use-env-proxy — флаг стоит в npm-скриптах.
# Задавать переменные приходится здесь: в User- и Machine-области их нет, а
# двойной клик по .cmd не наследует окружение терминала.
Step "Прокси"
$proxyUp = $null -ne (Get-NetTCPConnection -LocalPort 10801 -State Listen -ErrorAction SilentlyContinue)
if ($proxyUp) {
    if (-not $env:HTTP_PROXY)  { $env:HTTP_PROXY  = "http://127.0.0.1:10801" }
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = "http://127.0.0.1:10801" }
    $env:NO_PROXY = "hh.ru,.hh.ru,chatik.hh.ru,careerist.ru,.careerist.ru,hr.ge,.hr.ge,api.p.hr.ge"
    Ok "127.0.0.1:10801 слушает"
    Ok "OpenRouter пойдёт через прокси, площадки — напрямую (NO_PROXY)"
} else {
    Bad "на 127.0.0.1:10801 никто не слушает."
    Bad "Площадки работать будут, а письма — нет: запросы к OpenRouter упрутся"
    Bad "в блокировку провайдера и вернутся с 403. Запусти клиент прокси (xray)."
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
