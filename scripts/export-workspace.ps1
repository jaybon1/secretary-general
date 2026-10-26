# 업무 공간의 넘길 것(AGENTS.md, CLAUDE.md, MEMORY.md, skills/, .claude/)만 새 폴더로 복사하고 zip으로 묶는다.
# 결과물(output/), notes/, .git, 키·.env·로컬 설정은 넘기지 않는다. 묶기 전에 복사본을 검사해 걸린 줄(파일:줄, 이유)을 낸다:
# 이 PC 사용자 경로, 메일 주소, 키처럼 보이는 문자열, 주입 문구(src/threats.ts 패턴), -Names로 받은 사람 이름·호칭.
# 걸린 게 있으면 zip을 만들지 않고 복사본을 지운 뒤 종료 코드 3으로 끝난다. -Force면 그래도 묶는다.
# 기본 위치는 공간 옆 exports\<공간 폴더 이름>-<YYYYMMDD>\ 와 같은 이름의 .zip.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-workspace.ps1 -Folder <공간> [-Out <폴더>] [-Names 이름,호칭] [-Force]

param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [string]$Out,
  [string[]]$Names = @(),
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\claude-env.ps1"
$null = Use-Utf8Console

# Get-Item은 8.3 짧은 이름(예: ABCDEF~1)을 긴 이름으로 풀어 준다. 하위 파일 경로와 맞아야 상대 경로가 맞는다.
$src = (Get-Item -LiteralPath $Folder).FullName.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $src 'AGENTS.md'))) { Write-Output "공간 폴더가 아니에요(AGENTS.md 없음): $src"; exit 1 }
$leaf = Split-Path $src -Leaf
if (-not $Out) { $Out = Join-Path (Split-Path $src -Parent) ("exports\$leaf-" + (Get-Date -Format 'yyyyMMdd')) }
$Out = [IO.Path]::GetFullPath($Out).TrimEnd('\')
if ($Out -ieq $src -or $Out.StartsWith("$src\", [StringComparison]::OrdinalIgnoreCase)) { Write-Output "-Out은 공간 폴더 밖이어야 해요: $Out"; exit 1 }
$zip = "$Out.zip"
if ((Test-Path -LiteralPath $Out) -or (Test-Path -LiteralPath $zip)) { Write-Output "이미 있어요. 지우거나 -Out을 바꾸세요: $Out"; exit 1 }

# -File로 부르면 "a,b"가 한 덩어리로 오므로 쉼표로 다시 나눈다.
$Names = @($Names | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$include = 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'skills', '.claude'
# 넘길 폴더 안에 있어도 키·로컬 설정 파일은 뺀다.
$localFile = '^(\.env.*|.*\.(pem|key|pfx|p12)|id_rsa.*|id_ed25519.*|settings\.local\.json|credentials.*)$'
$left = @(Get-ChildItem -LiteralPath $src -Force | Where-Object { $include -notcontains $_.Name } | ForEach-Object { $_.Name })
$copied = @(); $skipped = @()
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Get-Item -LiteralPath $Out).FullName.TrimEnd('\')
$zip = "$Out.zip"
foreach ($name in $include) {
  $from = Join-Path $src $name
  if (-not (Test-Path -LiteralPath $from)) { continue }
  $items = if ((Get-Item -LiteralPath $from -Force).PSIsContainer) { @(Get-ChildItem -LiteralPath $from -Recurse -File -Force) } else { @(Get-Item -LiteralPath $from -Force) }
  foreach ($f in $items) {
    $rel = $f.FullName.Substring($src.Length + 1)
    if ($f.Name -match $localFile) { $skipped += $rel; continue }
    $to = Join-Path $Out $rel
    New-Item -ItemType Directory -Force (Split-Path $to -Parent) | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $to
    $copied += $rel
  }
}

# 검사. Skip은 걸린 값 중 넘겨도 되는 것, Hide는 미리보기에서 값을 가릴지.
$checks = @(
  @{ Why = '이 PC 사용자 경로'; Re = '(?i)\b[a-z]:[\\/]+Users[\\/]+(?![<%$])[^\\/\s"''`<>|]+'; Skip = '(?i)[\\/](Public|Default)$' },
  @{ Why = '이 PC 사용자 경로'; Re = '(?i)/(?:mnt/)?c/Users/(?![<%$])[^/\s"''`<>|]+'; Skip = '(?i)/(Public|Default)$' },
  @{ Why = '메일 주소'; Re = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'; Skip = '(?i)^(no-?reply|git)@|@example\.(com|org|net)$' },
  @{ Why = '키로 보이는 문자열'; Hide = $true; Re = '\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  @{ Why = '긴 base64(키일 수 있음)'; Hide = $true; Re = '(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}'; Long = $true }
)
foreach ($n in $Names) { $checks += @{ Why = "사람 호칭($n)"; Re = '(?i)' + [regex]::Escape($n) } }

function Test-LongBase64([string]$s) {
  # 대·소문자·숫자가 섞이고 구분자(-_/+)가 드문 것만. git 해시(소문자 hex)나 긴 파일 이름은 빼려고.
  $seps = ([regex]::Matches($s, '[-_/+]')).Count
  ($s -cmatch '[A-Z]') -and ($s -cmatch '[a-z]') -and ($s -match '\d') -and ($seps * 8 -lt $s.Length)
}

$hits = New-Object System.Collections.Generic.List[object]
$utf8 = New-Object Text.UTF8Encoding $false
foreach ($file in Get-ChildItem -LiteralPath $Out -Recurse -File -Force) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  if (-not $bytes.Length) { continue }
  if ([Array]::IndexOf($bytes[0..([Math]::Min($bytes.Length, 8000) - 1)], [byte]0) -ge 0) { continue }
  $rel = $file.FullName.Substring($Out.Length + 1).Replace('\', '/')
  $lines = $utf8.GetString($bytes).TrimStart([char]0xFEFF) -split "\r?\n"
  for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    $keyHit = $false
    foreach ($c in $checks) {
      if ($c.Long -and $keyHit) { continue }
      $found = @([regex]::Matches($line, $c.Re) | ForEach-Object { $_.Value } | Where-Object {
          (-not $c.Skip -or $_ -notmatch $c.Skip) -and (-not $c.Long -or (Test-LongBase64 $_))
        })
      if (-not $found.Count) { continue }
      if ($c.Hide) { $keyHit = $true }
      $preview = $line.Trim()
      if ($c.Hide) { foreach ($v in $found) { $preview = $preview.Replace($v, $v.Substring(0, 4) + '…(가림)') } }
      if ($preview.Length -gt 100) { $preview = $preview.Substring(0, 100) + '…' }
      $hits.Add([pscustomobject]@{ File = $rel; Line = $i + 1; Why = $c.Why; Text = $preview })
    }
  }
}

# 주입 문구는 비서 기억 저장 때 쓰는 패턴(src/threats.ts)을 그대로 쓴다.
$threatNote = ''
if (Get-Command node -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  $scan = @(& node --no-warnings "$PSScriptRoot\scan-threats.mjs" $Out 2>&1)
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { $threatNote = "주입 문구 검사: 확인 안 됨 (node 종료 코드 $code)" }
  else {
    foreach ($t in $scan) {
      $p = "$t" -split "`t"
      if ($p.Count -lt 3) { continue }
      $hits.Add([pscustomobject]@{ File = $p[0]; Line = [int]$p[1]; Why = "주입 문구($($p[2]))"; Text = '' })
    }
  }
} else { $threatNote = '주입 문구 검사: 확인 안 됨 (node 없음)' }

Write-Output "공간: $src"
Write-Output "넘길 파일 $($copied.Count)개 · 남긴 것: $(($left + $skipped) -join ', ')"
if ($threatNote) { Write-Output $threatNote }

if ($hits.Count) {
  Write-Output "걸린 줄 $($hits.Count)개:"
  $n = 0
  foreach ($h in ($hits | Sort-Object File, Line)) {
    $n++
    $tail = if ($h.Text) { " | $($h.Text)" } else { '' }
    Write-Output "$n. $($h.File):$($h.Line) · $($h.Why)$tail"
  }
  if (-not $Force) {
    Remove-Item -LiteralPath $Out -Recurse -Force
    Write-Output '결과: zip 안 만듦(복사본 지움). 공간 원본을 고친 뒤 다시 돌리거나, 그대로 넘기려면 -Force.'
    exit 3
  }
  Write-Output '-Force: 걸린 줄이 있지만 그대로 묶어요.'
} else {
  Write-Output '걸린 줄: 없음'
}

# CreateFromDirectory는 PowerShell 5.1(.NET Framework)에서 항목 이름에 \를 써서 맥·리눅스에서 폴더가 풀리지 않는다. 항목마다 /로 넣는다.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in Get-ChildItem -LiteralPath $Out -Recurse -File -Force) {
    $entry = $f.FullName.Substring($Out.Length + 1).Replace('\', '/')
    $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry)
  }
} finally { $archive.Dispose() }
Write-Output "결과: $zip"
exit 0
