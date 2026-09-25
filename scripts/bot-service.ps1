# Регистрирует бота в планировщике задач Windows: запуск при входе в систему,
# перезапуск при падении, без ограничения по времени работы.
#
# Запускать из корня репозитория один раз:
#   powershell -ExecutionPolicy Bypass -File scripts/bot-service.ps1
#
# Перезапустить (после правок в коде бота):
#   powershell -ExecutionPolicy Bypass -File scripts/bot-restart.ps1
# Не Stop-ScheduledTask: он оставляет cmd и node жить сиротами со старым кодом.
#
# Снять:
#   Unregister-ScheduledTask -TaskName job-autoapply-bot -Confirm:$false
#
# Бот всё равно молчит, пока спит компьютер или выключен VPN: «24/7» здесь
# означает «пока машина жива». Настоящий круглосуточный режим — это VPS, и
# переезд стоит двух файлов (src/bot/api.ts, src/bot/run.ts).
#
# Файл сохранён в UTF-8 с BOM: PowerShell 5.1 без BOM читает его как ANSI и
# превращает русский текст в кракозябры.
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$me = "$env:USERDOMAIN\$env:USERNAME"
$log = Join-Path $repo 'data\bot-service.log'

# Через cmd.exe, а не npm.cmd напрямую: планировщик запускает .cmd не во всяком
# окружении, и падение видно только по коду возврата. Здесь же вывод бота
# ложится в журнал, и причину отказа можно прочитать.
#
# conhost --headless прячет консоль. Без него на экране висит пустое окно
# cmd, и закрыть его по привычке значит молча убить бота: автоперезапуск
# планировщика срабатывает на падение, а не на закрытие окна руками.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c npm run bot >> `"$log`" 2>&1" `
  -WorkingDirectory $repo

# Без -User триггер означает «при входе любого пользователя», а такую задачу
# заводит только администратор: Register-ScheduledTask отвечает «Отказано в
# доступе» (0x80070005). С именем пользователя задача ставится из обычной сессии.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me

$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'job-autoapply-bot' -Action $action -Trigger $trigger -Settings $settings -User $me -Force | Out-Null

Write-Host 'Задача job-autoapply-bot зарегистрирована: стартует при входе в систему.'
Write-Host "Журнал:  $log"
Write-Host 'Проверить:  Get-ScheduledTask -TaskName job-autoapply-bot'
Write-Host 'Запустить сейчас:  Start-ScheduledTask -TaskName job-autoapply-bot'
Write-Host 'Перезапустить:  powershell -ExecutionPolicy Bypass -File scripts/bot-restart.ps1'
