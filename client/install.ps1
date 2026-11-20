param(
    [Parameter(Mandatory=$true)][ValidateSet('codex','workbuddy','zcode','qwen','openclaw','grok-cli','kimi','deepseek-harness','generic')][string]$Client,
    [Parameter(Mandatory=$true)][ValidateSet('images','video','episode','all')][string]$Skill,
    [string]$BaseUrl = '',
    [string]$TargetHome = ''
)
$ErrorActionPreference = 'Stop'
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$installerArguments = @((Join-Path $PSScriptRoot 'install.mjs'), '--client', $Client, '--skill', $Skill)
if ($BaseUrl -ne '') { $installerArguments += @('--base-url', $BaseUrl) }
if ($TargetHome -ne '') { $installerArguments += @('--home', $TargetHome) }
& $nodeExecutable @installerArguments
if ($LASTEXITCODE -ne 0) { throw 'Mubai client installation did not complete. Review the error above.' }
