# Кнопка «открыть панель». Основной вход в проект.
#
# Поиск и отправка живут В САМОЙ панели (правый верхний угол и вкладка
# «Одобрено»), поэтому здесь их нет: скрипт только проверяет окружение,
# поднимает панель и открывает её в браузере.
#
# Запуск: двойной клик по Панель.cmd, либо npm run panel:go

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   $text" -ForegroundColor DarkGray }
function Bad($text)  { Write-Host "   $text" -ForegroundColor Yellow }

Write-Host "Панель откликов" -ForegroundColor White

# --- 1. Ключ ------------------------------------------------------------
# Источник истины — файл .env: переменная окружения, выставленная через
# SetEnvironmentVariable, не видна в уже открытых терминалах, и это ровно
# один раз уже выглядело как «ключ пропал» при семи пустых письмах.
# Значение не печатаем, только длину.
Step "Ключ OpenRouter"
$envFile = Join-Path (Get-Location) ".env"
$key = $env:OPENROUTER_API_KEY
if (-not $key -and (Test-Path $envFile)) {
    $line = Select-String -Path $envFile -Pattern '^OPENROUTER_API_KEY=(.+)$' -ErrorAction SilentlyContinue
    if ($line) { $key = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $key) {
    Bad "не найден."
    Bad "Письма будут пустыми: вакансии попадут в очередь, но текст придётся писать руками."
    Bad "Ключ вписывается одной строкой в файл .env в корне проекта:"
    Write-Host '   OPENROUTER_API_KEY=sk-or-v1-...' -ForegroundColor DarkGray
} else {
    Ok "найден ($($key.Length) символов)"
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
# прогон оставляет Chromium висеть, и следующий поиск падает с «профиль
# занят» — сообщение, по которому причина не угадывается.
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

# --- 4. Уже запущенная панель -------------------------------------------
# Кнопку жмут по второму разу — это норма, и отвечать на это надо открытой
# вкладкой, а не попыткой занять уже занятый порт.
Step "Порт 4321"
$busy = $null -ne (Get-NetTCPConnection -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue)
if ($busy) {
    Ok "панель уже запущена — открываю вкладку"
    Start-Process "http://127.0.0.1:4321"
    Ok "закрыть её можно в том окне, где она работает (Ctrl+C)"
    exit 0
}
Ok "свободен"

# --- 5. Панель ----------------------------------------------------------
Step "Панель"
Ok "поиск — в правом верхнем углу: впиши, сколько вакансий нужно, и нажми «Найти»"
Ok "отправка — на вкладке «Одобрено», кнопка «Отправить всё»"
Ok "остановить панель: Ctrl+C в этом окне"

# Открываем браузер ДО npm run panel: команда не возвращает управление, пока
# панель слушает, так что после неё этой строки бы уже не случилось.
# Небольшая пауза — чтобы вкладка не открылась в пустой порт раньше сервера.
Start-Job { Start-Sleep -Seconds 3; Start-Process "http://127.0.0.1:4321" } | Out-Null
npm run panel
