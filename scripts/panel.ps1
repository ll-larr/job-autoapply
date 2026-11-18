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

# Node.js и npm добавляются в PATH только на время работы лаунчера.
function Get-PanelNpm {
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $npm -or -not $node) { return }
    $major = & $node.Source -p "process.versions.node.split('.')[0]" 2>$null
    if ($LASTEXITCODE -eq 0 -and $major -match '^\d+$' -and [int]$major -ge 24) {
        return $npm.Source
    }
}

function Install-PanelNode {
    $version = 'v24.22.3'
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    $hash = switch ($arch) {
        'AMD64' { 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'; break }
        'ARM64' { 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'; break }
        default { throw "Поддерживаются Windows x64 и ARM64. Архитектура: $arch." }
    }
    if ($arch -eq 'AMD64') { $arch = 'x64' }
    $dist = "node-$version-win-$($arch.ToLowerInvariant())"
    $runtime = Join-Path (Get-Location) '.runtime'
    $nodeDir = Join-Path $runtime $dist
    $localNode = Join-Path $nodeDir 'node.exe'
    $localNpm = Join-Path $nodeDir 'npm.cmd'

    if (-not (Test-Path -LiteralPath $localNode) -or -not (Test-Path -LiteralPath $localNpm)) {
        Step "Скачиваю Node.js $version ($arch)"
        $stage = Join-Path $runtime ([guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        try {
            $archive = Join-Path $stage "$dist.zip"
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "https://nodejs.org/dist/$version/$dist.zip" -OutFile $archive
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $hash) {
                throw "Контрольная сумма Node.js не совпала."
            }
            Expand-Archive -LiteralPath $archive -DestinationPath $stage
            try {
                [IO.Directory]::Move((Join-Path $stage $dist), $nodeDir)
            } catch [IO.IOException] {
                # Другой запуск мог уже распаковать тот же архив.
                if (-not (Test-Path -LiteralPath $localNode) -or -not (Test-Path -LiteralPath $localNpm)) { throw }
            }
        } finally {
            # Каталог создан выше специально для этой загрузки.
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
    }
    if (-not (Test-Path -LiteralPath $localNode) -or -not (Test-Path -LiteralPath $localNpm)) {
        throw "Node.js не распакован. Удали каталог .runtime/$dist и повтори запуск."
    }
    $env:Path = "$nodeDir;$env:Path"
    return $localNpm
}

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
# Здесь больше ничего не задаётся: прокси для писем программа ищет сама, в
# момент запроса (src/core/proxy.ts), и при старте печатает, что нашла. Раньше
# тут подбирался порт и выставлялись HTTP_PROXY/HTTPS_PROXY, один раз и с
# зашитым 10801. 2026-09-18 VPN-клиент сменил порт, и письма встали.

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

# --- 5. Зависимости и панель ---------------------------------------------
Step "Подготовка зависимостей"
try {
    $npm = Get-PanelNpm
    if (-not $npm) { $npm = Install-PanelNode }
    & $npm run setup:panel
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Bad "Не удалось подготовить зависимости: $_"
    exit 1
}

# --- 6. Панель ----------------------------------------------------------
Step "Панель"
Ok "поиск — в правом верхнем углу: впиши, сколько вакансий нужно, и нажми «Найти»"
Ok "отправка — на вкладке «Одобрено», кнопка «Отправить всё»"
Ok "остановить панель: Ctrl+C в этом окне"

# Открываем браузер ДО npm run panel: команда не возвращает управление, пока
# панель слушает, так что после неё этой строки бы уже не случилось.
# Небольшая пауза — чтобы вкладка не открылась в пустой порт раньше сервера.
Start-Job { Start-Sleep -Seconds 3; Start-Process "http://127.0.0.1:4321" } | Out-Null
& $npm run panel
exit $LASTEXITCODE
