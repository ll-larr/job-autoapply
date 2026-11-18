# Перезапуск бота под планировщиком:
#   powershell -ExecutionPolicy Bypass -File scripts/bot-restart.ps1
#
# Stop-ScheduledTask тут не годится. Он убивает только процесс действия
# (conhost), а его потомки cmd и node на Windows остаются жить сиротами — со
# старым кодом и с занятой очередью getUpdates. Новый запуск упирается в них и
# выходит, и снаружи это выглядит как «перезапустил, а ничего не поменялось».
# Поэтому дерево гасим сами, от верхнего предка вниз.
#
# Файл в UTF-8 с BOM: иначе PowerShell 5.1 читает русский текст как ANSI.
$ErrorActionPreference = 'Stop'
$pattern = 'cli\.ts bot'

$procs = Get-CimInstance Win32_Process
$bots = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $pattern })

$roots = foreach ($b in $bots) {
  $p = $b
  # Вверх по цепочке conhost → cmd → node → node, пока предок из неё.
  while ($true) {
    $parent = $procs | Where-Object ProcessId -eq $p.ParentProcessId
    if ($null -eq $parent -or $parent.Name -notin @('node.exe', 'cmd.exe', 'conhost.exe')) { break }
    $p = $parent
  }
  $p.ProcessId
}
foreach ($id in ($roots | Sort-Object -Unique)) { taskkill /T /F /PID $id | Out-Null }

Stop-ScheduledTask -TaskName 'job-autoapply-bot' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern })
if ($left.Count -gt 0) {
  Write-Host "Не все процессы бота остановились: $($left.Count). Новый не запускаю — будет конфликт getUpdates."
  exit 1
}

Start-ScheduledTask -TaskName 'job-autoapply-bot'
Write-Host 'Бот перезапущен. Проверить:  Get-ScheduledTaskInfo -TaskName job-autoapply-bot  (267009 — работает)'
