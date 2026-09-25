# Регистрирует бота в планировщике задач Windows: запуск при входе в систему,
# перезапуск при падении, без ограничения по времени работы.
#
# Запускать из корня репозитория один раз:
#   powershell -ExecutionPolicy Bypass -File scripts/bot-service.ps1
#
# Снять:
#   Unregister-ScheduledTask -TaskName job-autoapply-bot -Confirm:$false
#
# Бот всё равно молчит, пока спит компьютер или выключен VPN: «24/7» здесь
# означает «пока машина жива». Настоящий круглосуточный режим — это VPS, и
# переезд стоит двух файлов (src/bot/api.ts, src/bot/run.ts).
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'npm.cmd' -Argument 'run bot' -WorkingDirectory $repo
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
Write-Host 'Проверить:  Get-ScheduledTask -TaskName job-autoapply-bot'
Write-Host 'Запустить сейчас:  Start-ScheduledTask -TaskName job-autoapply-bot'
