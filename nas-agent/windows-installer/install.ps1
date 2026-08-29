[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "Salva Agent"
$installDir = Join-Path $env:ProgramData "SalvaAgent"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  Write-Host "Administrator permission is required. Opening Windows confirmation..." -ForegroundColor Cyan
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
}

Write-Host ""
Write-Host "SALVA AGENT FOR WINDOWS" -ForegroundColor Blue
Write-Host "This installer shares one folder only. Do not select the whole Windows drive." -ForegroundColor DarkGray
Write-Host ""

$storageRoot = Read-Host "Storage folder (example D:\NAS)"
if (-not [IO.Path]::IsPathFullyQualified($storageRoot) -or -not (Test-Path -LiteralPath $storageRoot -PathType Container)) {
  throw "Choose an existing absolute folder."
}

do {
  $publicUrl = (Read-Host "Public HTTPS endpoint (example https://disk.example.com)").Trim().TrimEnd("/")
  $validUrl = $publicUrl -match '^https://[A-Za-z0-9.-]+(?::\d+)?$'
  if (-not $validUrl) { Write-Host "Enter a public HTTPS URL without a path." -ForegroundColor Yellow }
} until ($validUrl)

$portInput = Read-Host "Local agent port [8787]"
$port = if ([string]::IsNullOrWhiteSpace($portInput)) { 8787 } else { [int]$portInput }
if ($port -lt 1024 -or $port -gt 65535) { throw "Port must be between 1024 and 65535." }

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeMajor = if ($nodeCommand) { [int]((& $nodeCommand.Source --version).TrimStart("v").Split(".")[0]) } else { 0 }
if ($nodeMajor -lt 20) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Node.js 20+ is required. Install Node.js LTS from https://nodejs.org, then run this installer again." }
  Write-Host "Installing Node.js LTS..." -ForegroundColor Cyan
  & $winget.Source install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Node.js installation failed." }
}

$nodeCandidates = @((Join-Path $env:ProgramFiles "nodejs\node.exe"))
if (${env:ProgramFiles(x86)}) { $nodeCandidates += Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe" }
$resolvedNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($resolvedNode) { $nodeCandidates += $resolvedNode.Source }
$nodePath = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $nodePath) { throw "node.exe could not be found. Restart Windows and run the installer again." }

$tokenBytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$token = [Convert]::ToBase64String($tokenBytes)

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "server.mjs") -Destination $installDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "service-runner.mjs") -Destination $installDir -Force
$configPath = Join-Path $installDir "agent.json"
@{
  root = (Resolve-Path -LiteralPath $storageRoot).Path
  token = $token
  origin = "https://cloud.salvadev.space"
  publicUrl = $publicUrl
  port = $port
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8

& icacls.exe $installDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"{0}" "{1}"' -f (Join-Path $installDir "service-runner.mjs"), $configPath) -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2

$headers = @{ Authorization = "Bearer $token" }
$body = @{ operation = "health"; input = @{} } | ConvertTo-Json
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/control" -Method Post -Headers $headers -ContentType "application/json" -Body $body
if ($health.protocol -ne "cloud-nas-v1") { throw "Agent health check returned an incompatible protocol." }

$resultPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Salva-Agent-Connection.txt"
@"
Salva Agent is installed.

Connection type: Salva Agent API
Public HTTPS endpoint: $publicUrl
Agent token: $token
Local tunnel target: http://127.0.0.1:$port
Windows startup task: $taskName

Connect your tunnel hostname to the local tunnel target, verify the public endpoint,
then paste the HTTPS endpoint and token into Salva Cloud. Delete this file after pairing.
"@ | Set-Content -LiteralPath $resultPath -Encoding utf8

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Auto-start task : $taskName"
Write-Host "Tunnel target   : http://127.0.0.1:$port"
Write-Host "Connection info : $resultPath"
Write-Host "Keep the token private and delete the connection file after pairing." -ForegroundColor Yellow
Read-Host "Press Enter to close"
