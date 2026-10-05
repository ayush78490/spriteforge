# Lists the apps in the current user's session with the RAM each one really occupies
# (private working set, the same number as Task Manager's "Memory" column), as JSON.
$sid = (Get-Process -Id $PID).SessionId
$priv = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, WorkingSetPrivate |
  ForEach-Object { $priv[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
$apps = Get-Process | Where-Object { $_.SessionId -eq $sid -and $_.Id -ne $PID } | Group-Object ProcessName | ForEach-Object {
  $g = $_.Group
  $main = $g | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  $first = if ($main) { $main } else { $g[0] }
  [pscustomobject]@{
    name = $_.Name; title = $first.Description; path = $first.Path; count = $g.Count; hasWindow = [bool]$main
    bytes = [int64](($g | ForEach-Object { $priv[$_.Id] } | Measure-Object -Sum).Sum); pids = @($g | ForEach-Object { $_.Id })
  }
}
@($apps | Sort-Object bytes -Descending) | ConvertTo-Json -Compress -Depth 3
