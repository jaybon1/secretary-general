# run-job.ps1이 dot-source 한다: Claude Code가 아닌 다른 회사 CLI 공급자(providers.json의 copilot-cli, antigravity-cli)로
# 지시 하나를 돌린다. 기능 'external-providers'(처음엔 꺼짐, feature-toggle 스킬로 켠다)의 일부로, providers.json에 그 공급자를 넣어야 쓰인다.
# 결과 글은 화면으로 바로 내보내고 종료 코드를 돌려준다(이어 부르기·호출 기록·기억 MCP 없음).

$OtherCliTypes = @('copilot-cli', 'antigravity-cli')

# agy는 .agents/skills.json의 공간 밖 경로(공통 스킬 workspaces\_skills, src/workspace/common-skills.ts가 쓴다)를 거절하므로,
# 그 폴더를 --add-dir로 더해야 include_only로 고른 공통 스킬이 읽힌다. 목록 파일의 경로는 절대 경로여야 한다(상대 경로는 --add-dir가 있어도 거절, 2026-11-07 시험). 옛 상대 경로도 작업 폴더 기준으로 풀어 더한다.
function Get-AgySkillDirs([string]$Folder) {
  $file = Join-Path $Folder '.agents\skills.json'
  if (-not (Test-Path $file -PathType Leaf)) { return @() }
  try { $entries = (Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json).entries } catch { return @() }
  $root = [IO.Path]::GetFullPath($Folder).TrimEnd('\') + '\'
  foreach ($e in @($entries)) {
    if (-not $e.path) { continue }
    $p = if ([IO.Path]::IsPathRooted($e.path)) { $e.path } else { Join-Path $Folder $e.path }
    $p = [IO.Path]::GetFullPath($p).TrimEnd('\')
    if ((Test-Path $p -PathType Container) -and -not ($p + '\').StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $p }
  }
}

function Invoke-OtherCliJob($info, [string]$Model, [string]$Prompt, [string]$Folder) {
  if ($info.Type -eq 'copilot-cli') {
    # Copilot CLI: 지시는 표준입력으로, 도구는 작업 폴더 안에서 묻지 않고 허용한다(-s는 결과 글만 출력).
    $Prompt | copilot -s --allow-all-tools --model $Model | Out-Host
    return $LASTEXITCODE
  }
  if ($info.Type -eq 'antigravity-cli') {
    # agy 안에서는 사용량 정지 훅이 돌지 않으므로, 시작 전에 사용량(토큰 0)을 새로 받아 이 모델 묶음이 90% 이상이면 시작하지 않는다.
    # 일하는 도중에 한도를 넘는 것은 막지 못한다. 조회가 실패하면 막지 않고 그대로 돌린다.
    & "$ScriptsDir\usage\usage-query.ps1" -Provider $info.Name | Out-Null
    try { $usage = Get-Content -Raw -Encoding UTF8 (Get-UsageFile $info.Name) | ConvertFrom-Json } catch { $usage = $null }
    $groupName = if ($Model -like 'gemini*') { 'Gemini' } else { 'Claude' }
    $group = $usage.groups | Where-Object { $_.name -like "$groupName*" } | Select-Object -First 1
    if ($group -and $group.used_pct -ge 90) {
      $resets = ConvertTo-KstText ([DateTime]::Parse($group.resets_at).ToUniversalTime()) 'M\/d HH:mm'
      [Console]::Error.WriteLine("$($info.Name)의 $($group.name) 주간 사용량이 $($group.used_pct)%라 시작하지 않았어요. 초기화: $resets (KST)")
      return 4
    }
    # agy는 표준입력 지시를 읽지 않고, 긴 인자는 따옴표가 깨지므로 지시를 작업 폴더의 임시 파일로 넘긴다.
    # agy 샌드박스가 없는 PC에서는 auto 모드가 안 되므로 승인 없이 돈다(이 공급자를 켤 때 사용자에게 먼저 알리고 승인받는다).
    $jobFile = Join-Path $Folder ".agy-job-$PID.md"
    Write-Utf8File $jobFile $Prompt
    try {
      $addDirs = @(Get-AgySkillDirs $Folder | ForEach-Object { '--add-dir'; $_ })
      & (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe') --dangerously-skip-permissions --model $Model @addDirs "-p=Read the file $(Split-Path $jobFile -Leaf) in the current folder and carry out its instructions exactly. Do not modify or delete that file." | Out-Host
      $code = $LASTEXITCODE
    } finally { Remove-Item $jobFile -ErrorAction SilentlyContinue }
    return $code
  }
}
