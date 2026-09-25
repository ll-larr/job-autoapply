# Регистрирует автоответ ГигаРекрутёру в планировщике задач Windows: разовое
# открытие окна первым запуском и поллинг раз в 4 часа без срока после него
# (спека 2026-09-25, 3.5).
#
# Запускать из корня репозитория один раз:
#   powershell -ExecutionPolicy Bypass -File scripts/interview-service.ps1
#
# Снять обе задачи:
#   Unregister-ScheduledTask -TaskName job-autoapply-interview-window -Confirm:$false
#   Unregister-ScheduledTask -TaskName job-autoapply-interview-poll -Confirm:$false
#
# Дата первого запуска (2026-09-25T22:40) зашита один раз, под живой прогон
# того дня. Перерегистрировать с новой датой — снять обе задачи командами
# выше и запустить этот файл заново после правки $windowTrigger/$pollTrigger.
#
# Файл сохранён в UTF-8 с BOM: PowerShell 5.1 без BOM читает его как ANSI и
# превращает русский текст в кракозябры.
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$me = "$env:USERDOMAIN\$env:USERNAME"
$log = Join-Path $repo 'data\interview-service.log'

# Через cmd.exe, а не npm.cmd напрямую — см. scripts/bot-service.ps1: планировщик
# запускает .cmd не во всяком окружении, и падение видно только по коду
# возврата. conhost --headless прячет консоль по той же причине: пустое окно
# cmd на экране приглашает закрыть его руками, а обе задачи и так работают по
# расписанию, а не висят постоянно.
$windowAction = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c npm run interview -- --window >> `"$log`" 2>&1" `
  -WorkingDirectory $repo

$pollAction = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c npm run interview >> `"$log`" 2>&1" `
  -WorkingDirectory $repo

# Разово в 22:40 2026-09-25 (спека 3.5): открывает окно на windowMinutes и,
# если ГигаРекрутёр уже писал, отвечает сразу.
$windowTrigger = New-ScheduledTaskTrigger -Once -At '2026-09-25T22:40:00'

# С 00:40 2026-09-26 (конец первого окна) — раз в 4 часа без ограничения по
# сроку: RepetitionDuration не задан нарочно — планировщик считает это
# «повторять бессрочно», а не «один раз через 4 часа».
$pollTrigger = New-ScheduledTaskTrigger -Once -At '2026-09-26T00:40:00' `
  -RepetitionInterval (New-TimeSpan -Hours 4)

# MultipleInstances по умолчанию IgnoreNew: если предыдущий прогон ещё не
# закончился, планировщик не запустит второй поверх него — вторая линия
# защиты сверх файловой блокировки data/interview.lock (задача 7).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'job-autoapply-interview-window' -Action $windowAction -Trigger $windowTrigger -Settings $settings -User $me -Force | Out-Null
Register-ScheduledTask -TaskName 'job-autoapply-interview-poll' -Action $pollAction -Trigger $pollTrigger -Settings $settings -User $me -Force | Out-Null

Write-Host 'Задачи job-autoapply-interview-window и job-autoapply-interview-poll зарегистрированы.'
Write-Host "Журнал:  $log"
Write-Host 'Проверить:  Get-ScheduledTask -TaskName job-autoapply-interview-window,job-autoapply-interview-poll'
Write-Host 'Запустить поллинг сейчас:  Start-ScheduledTask -TaskName job-autoapply-interview-poll'
Write-Host 'Снять:  Unregister-ScheduledTask -TaskName job-autoapply-interview-window,job-autoapply-interview-poll -Confirm:$false'
