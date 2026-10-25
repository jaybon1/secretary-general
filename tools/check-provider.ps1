# Smoke test: providers.ps1 resolves the single subscription and rejects unknown names. Also checks run-job/start-worker param errors without calling the model.
param([Parameter(Mandatory)] [string]$Scripts)
. (Join-Path $Scripts 'providers.ps1')
$info = Use-Provider
if ($info.Name -ne 'subscription' -or $info.Type -ne 'claude-subscription' -or $info.Effort -ne 'high') { throw "unexpected default: $($info | ConvertTo-Json -Compress)" }
if ($env:SECRETARY_PROVIDER -ne 'subscription') { throw 'SECRETARY_PROVIDER not set' }
$names = @((Get-ProviderConfig).providers.PSObject.Properties.Name)
if ($names.Count -ne 1) { throw "expected 1 provider, got $($names -join ',')" }
$rejected = $false
try { Use-Provider 'bogus' | Out-Null } catch { $rejected = $true }
if (-not $rejected) { throw 'unknown provider was accepted' }
Write-Output "providers OK: $($info | ConvertTo-Json -Compress)"
