$ErrorActionPreference = "Stop"
$taskName = "Salva Agent"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Wait -PassThru
  exit $process.ExitCode
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $env:ProgramData "SalvaAgent") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Salva Agent was removed. Your storage files were not deleted." -ForegroundColor Green
