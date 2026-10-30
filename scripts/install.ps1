[CmdletBinding()]
param([switch]$Plan, [switch]$NativeOnly)
$ErrorActionPreference = 'Stop'
$buddyRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buddyNode = (Get-Command node -ErrorAction Stop).Source
$buddyId = (Get-Content -LiteralPath (Join-Path $buddyRoot 'extension-id.txt') -Raw).Trim()
if ($buddyId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID. Run node scripts/prepare.mjs first.' }
$buddyState = Join-Path $env:LOCALAPPDATA 'CodexBrowserBuddy'
$buddyHostFile = Join-Path $buddyState 'native-host.json'
$buddyLauncher = Join-Path $buddyState 'native-host.cmd'
$buddyRegistry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.codex.browser_buddy'
$buddyConfigRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$buddyConfig = Join-Path $buddyConfigRoot 'config.toml'
$buddyRegistered = if (Test-Path -LiteralPath $buddyRegistry) { (Get-Item -LiteralPath $buddyRegistry).GetValue('') } else { $null }
$buddyReuseRegistration = [string]::Equals($buddyRegistered, $buddyHostFile, [StringComparison]::OrdinalIgnoreCase)

Write-Output "Extension folder: $(Join-Path $buddyRoot 'extension')"
Write-Output "Native host registration: $buddyRegistry"
Write-Output "Native host files: $buddyState"
Write-Output 'Scope: current Windows user only; no administrator rights or Chrome restart required.'
if (-not $NativeOnly) { Write-Output 'Codex: add the browser-use-local marketplace and install codex-browser-use.' }
if ($Plan) { Write-Output 'Plan only. No files, registry entries, or Codex settings were changed.'; return }
if (-not $NativeOnly) { $buddyCodex = (Get-Command codex -ErrorAction Stop).Source }

$buddyStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$buddyBackup = Join-Path $buddyState "backups\$buddyStamp"
New-Item -ItemType Directory -Path $buddyBackup -Force | Out-Null
if ((Test-Path -LiteralPath $buddyRegistry) -and (-not $buddyReuseRegistration)) {
  & reg.exe export 'HKCU\Software\Google\Chrome\NativeMessagingHosts\local.codex.browser_buddy' (Join-Path $buddyBackup 'native-host.reg') /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not back up the existing native host registration.' }
}
foreach ($buddyFile in @($buddyHostFile, $buddyLauncher)) {
  if (Test-Path -LiteralPath $buddyFile) { Copy-Item -LiteralPath $buddyFile -Destination $buddyBackup }
}
if ((-not $NativeOnly) -and (Test-Path -LiteralPath $buddyConfig)) {
  Copy-Item -LiteralPath $buddyConfig -Destination (Join-Path $buddyBackup 'config.toml')
}

$buddyUtf8 = New-Object Text.UTF8Encoding($false)
$buddyNodeCmd = $buddyNode.Replace('%', '%%')
$buddyServerCmd = (Join-Path $buddyRoot 'src\native-host.mjs').Replace('%', '%%')
$buddyCommand = "@echo off`r`nsetlocal DisableDelayedExpansion`r`nchcp 65001 >nul`r`n`"$buddyNodeCmd`" `"$buddyServerCmd`" %*`r`n"
[IO.File]::WriteAllText($buddyLauncher, $buddyCommand, $buddyUtf8)
$buddyManifest = @{
  name = 'local.codex.browser_buddy'
  description = 'Local Chrome bridge for Codex Browser Use'
  path = $buddyLauncher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$buddyId/")
}
[IO.File]::WriteAllText($buddyHostFile, ($buddyManifest | ConvertTo-Json -Depth 5), $buddyUtf8)
if ($buddyReuseRegistration) {
  Write-Output 'Reusing the existing native host registration; no registry edit is needed.'
} else {
  New-Item -Path $buddyRegistry -Force | Out-Null
  Set-Item -LiteralPath $buddyRegistry -Value $buddyHostFile
}

if (-not $NativeOnly) {
  & $buddyCodex plugin marketplace add $buddyRoot
  if ($LASTEXITCODE -ne 0) { throw 'Native host installed, but marketplace registration failed. See README fallback instructions.' }
  & $buddyCodex plugin add 'codex-browser-use@browser-use-local'
  if ($LASTEXITCODE -ne 0) { throw 'Marketplace registered, but plugin installation failed. Open the Codex Plugins page to install it.' }
}
Write-Output "Backup saved locally: $buddyBackup"
Write-Output 'Next: Chrome > chrome://extensions > Developer mode > Load unpacked > choose the extension folder above.'
Write-Output 'Then click Reconnect in the extension popup and start a new Codex chat.'
