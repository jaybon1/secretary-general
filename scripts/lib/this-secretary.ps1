# 이 비서 전용 설정 읽기(PowerShell 쪽). 비서 폴더 맨 위 this-secretary.local.json(커밋하지 않음, 예시 this-secretary.local.example.json)의 키 하나를 돌려준다.
# 규칙은 TS 쪽 src/core/this-secretary.ts와 같다: 키 이름은 기능 id(features.json), 그 기능이 꺼져 있으면(enabled false) 그 키를 읽지 않는다.
# features.json이 없거나 못 읽거나 그 기능이 목록에 없으면 켜진 것으로 본다(모든 기능과 같다). paths 키는 기능과 상관없이 읽는다.
# common.ps1이 dot-source 하고, common.ps1을 부르지 않는 스크립트도 직접 부를 수 있게 common.ps1에 기대지 않는다.

# 비서 폴더: 이 파일이 scripts/lib/에 있으므로 두 단계 위.
$ThisSecretaryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# 키 값(PSCustomObject·배열 등), 없으면 $null. 파일이 JSON이 아니면 예외(무엇이 틀렸는지 보이게).
function Get-ThisSecretarySection([string]$Name, [string]$Root = $ThisSecretaryRoot) {
  if ($Name -ne 'paths') {
    $featuresFile = Join-Path $Root 'features.json'
    $list = $null
    if (Test-Path -LiteralPath $featuresFile) {
      try { $list = (Get-Content -Raw -Encoding UTF8 -LiteralPath $featuresFile | ConvertFrom-Json).features } catch { $list = $null }
    }
    $f = @($list | Where-Object { $_ -and $_.id -eq $Name }) | Select-Object -First 1
    if ($f -and -not $f.core -and $f.enabled -eq $false) { return $null }
  }
  $file = Join-Path $Root 'this-secretary.local.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $all = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
  if ($null -eq $all -or -not ($all.PSObject.Properties.Name -contains $Name)) { return $null }
  # 배열 값(예: 서버와 같이 켜는 프로그램 목록)은 , 를 붙여 배열 하나로 돌려준다(PowerShell이 낱개로 풀지 않게). 받는 쪽은 foreach로 돈다.
  $value = $all.$Name
  if ($value -is [array]) { return ,$value }
  $value
}

# 이 비서 설정 파일의 자리(알림 글용).
function Get-ThisSecretaryFile([string]$Root = $ThisSecretaryRoot) { Join-Path $Root 'this-secretary.local.json' }
