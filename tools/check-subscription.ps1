# Smoke test: scripts/lib/providers.ps1 resolves the shipped default (the one subscription) and rejects unknown names. No model is called.
# ASCII only on purpose (no BOM). Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-subscription.ps1 -Scripts <secretary>\scripts
param([Parameter(Mandatory)] [string]$Scripts)
. (Join-Path $Scripts 'lib\common.ps1')
. (Join-Path $Scripts 'lib\providers.ps1')
$info = Use-Provider
if ($info.Name -ne 'subscription' -or $info.Type -ne 'claude-subscription' -or $info.Effort -ne 'high') { throw "unexpected default: $($info | ConvertTo-Json -Compress)" }
if ($env:SECRETARY_PROVIDER -ne 'subscription') { throw 'SECRETARY_PROVIDER not set' }
$names = @((Get-ProviderConfig).providers.PSObject.Properties.Name)
if ($names.Count -ne 1) { throw "expected 1 provider as shipped, got $($names -join ',')" }
$rejected = $false
try { Use-Provider 'bogus' | Out-Null } catch { $rejected = $true }
if (-not $rejected) { throw 'unknown provider name was accepted' }
Write-Output "subscription OK: $($info | ConvertTo-Json -Compress)"
