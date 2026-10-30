[CmdletBinding()]
param([switch]$NativeOnly)
$ErrorActionPreference = 'Stop'
$buddyRegistry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.codex.browser_buddy'
$buddyExpected = Join-Path $env:LOCALAPPDATA 'CodexBrowserBuddy\native-host.json'
if (Test-Path -LiteralPath $buddyRegistry) {
  $buddyCurrent = (Get-Item -LiteralPath $buddyRegistry).GetValue('')
  if ($buddyCurrent -ne $buddyExpected) { throw 'The native host registration points elsewhere. Refusing to remove another installation.' }
  Remove-Item -LiteralPath $buddyRegistry
}
if (-not $NativeOnly) {
  & codex plugin remove 'codex-browser-use@browser-use-local'
  if ($LASTEXITCODE -ne 0) { throw 'Remove the plugin from the Codex Plugins page, then retry.' }
  & codex plugin marketplace remove 'browser-use-local'
  if ($LASTEXITCODE -ne 0) { throw 'Plugin removed; marketplace removal failed. Remove browser-use-local from Codex manually.' }
}
Write-Output 'Registration removed. Remove Codex Browser Use from chrome://extensions.'
Write-Output 'Source files and configuration backups are preserved. Do not overwrite current config.toml with an old backup unless you intend to restore it.'
