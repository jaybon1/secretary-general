# run-job에 비서 자신의 코드 일을 맡길 작업 사본(git worktree)을 만들고 지운다(delegate 스킬 "누가 하나", 2026-11-12 결정).
# 비서 훅과 예약 작업이 비서 폴더의 src를 그대로 실행하므로, 고치는 도중의 코드는 비서 폴더 밖 작업 사본에서 다룬다.
#
# 만들기: workspaces\_run-job-home\output\research\<Name>\wt 에 main에서 브랜치 <Branch>로 worktree를 만들고,
#   wt\node_modules에 원본 node_modules로 가는 정션을 단다(설치를 다시 하지 않고 원본 패키지를 읽기만 한다).
# 지우기: 정션을 먼저 cmd /c rmdir로 뗀다(PowerShell 5.1의 Remove-Item은 정션 너머 원본 파일까지 지울 수 있다).
#   node_modules가 정션이 아닌 진짜 폴더면 멈추고 알린다. 이어서 git worktree remove(고친 파일이 남아 있으면 git이 멈춘다),
#   브랜치는 main에 합쳐졌을 때만 git branch -d로 지운다. 연구 폴더(보고서 등)는 남긴다.
# workspaces는 SECRETARY_WORKSPACE_ROOT, 없으면 비서 폴더 옆(run-job.ps1, src/core/config.ts WORKSPACE_ROOT와 같다).
# 비서 폴더는 이 스크립트가 든 저장소의 원본 작업 트리(git rev-parse --git-common-dir의 부모)라 작업 사본에서 불러도 원본을 쓴다.
#
# 예: powershell -NoProfile -ExecutionPolicy Bypass -File bin/run-job-worktree.ps1 add 20261112-일이름 <브랜치>
#     powershell -NoProfile -ExecutionPolicy Bypass -File bin/run-job-worktree.ps1 remove 20261112-일이름

param(
  [Parameter(Mandatory, Position = 0)] [ValidateSet('add', 'remove')] [string]$Action,
  [Parameter(Mandatory, Position = 1)] [string]$Name,
  [Parameter(Position = 2)] [string]$Branch
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

if ($Name -notmatch '^[\w.-]+$' -or $Name -match '^\.+$') { throw "연구 폴더 이름은 폴더 하나 이름만 줘요(예: 20261112-일이름): $Name" }

$repoHere = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$commonDir = (& git -C $repoHere rev-parse --path-format=absolute --git-common-dir)
if ($LASTEXITCODE -ne 0 -or -not $commonDir) { throw "git 저장소를 찾지 못했어요: $repoHere" }
$secretaryRoot = Split-Path -Parent ([IO.Path]::GetFullPath($commonDir.Trim()))
$sourceModules = Join-Path $secretaryRoot 'node_modules'

$workspaceRoot = if ($env:SECRETARY_WORKSPACE_ROOT) { $env:SECRETARY_WORKSPACE_ROOT } else { Join-Path (Split-Path -Parent $secretaryRoot) 'workspaces' }
$home_ = Join-Path $workspaceRoot '_run-job-home'
if (-not (Test-Path $home_)) { throw "run-job 기본 작업 폴더가 없어요: $home_ (SECRETARY_WORKSPACE_ROOT=$($env:SECRETARY_WORKSPACE_ROOT))." }
$research = Join-Path $home_ "output\research\$Name"
$wt = Join-Path $research 'wt'
$modules = Join-Path $wt 'node_modules'

function Invoke-Git {
  & git -C $secretaryRoot @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') 실패(종료 코드 $LASTEXITCODE)" }
}

if ($Action -eq 'add') {
  if (-not $Branch) { throw '만들 때는 브랜치 이름을 줘요: add <연구 폴더 이름> <브랜치>' }
  if (Test-Path $wt) { throw "작업 사본 자리가 이미 있어요: $wt" }
  if (-not (Test-Path $sourceModules)) { throw "원본 node_modules가 없어요: $sourceModules (비서 폴더에서 npm install)" }
  New-Item -ItemType Directory -Force $research | Out-Null
  Invoke-Git worktree add -b $Branch $wt main
  New-Item -ItemType Junction -Path $modules -Target $sourceModules | Out-Null
  $head = (& git -C $wt rev-parse --short HEAD)
  Write-Output "작업 사본: $wt"
  Write-Output "브랜치: $Branch (main $($head)에서)"
  Write-Output "node_modules: 원본으로 가는 정션($sourceModules)"
  exit 0
}

# remove
if (-not (Test-Path $wt)) { throw "작업 사본이 없어요: $wt" }
if (-not $Branch) { $Branch = (& git -C $wt branch --show-current) }
if (Test-Path $modules) {
  $item = Get-Item -LiteralPath $modules -Force
  if ($item.LinkType -ne 'Junction') {
    throw "멈춤: $modules 이(가) 정션이 아닌 진짜 폴더예요. 원본 node_modules와 상관없는지 확인한 뒤 직접 정리해 주세요."
  }
  & cmd /c rmdir "$modules"
  if ($LASTEXITCODE -ne 0 -or (Test-Path $modules)) { throw "정션을 떼지 못했어요: $modules" }
  if (-not (Test-Path $sourceModules)) { throw "정션을 뗀 뒤 원본 node_modules가 보이지 않아요: $sourceModules" }
  Write-Output "정션 뗌: $modules (원본 그대로)"
}
Invoke-Git worktree remove $wt
Write-Output "작업 사본 지움: $wt"
if (-not $Branch) { Write-Output '브랜치: 알 수 없음(분리된 HEAD), 그대로 둠'; exit 0 }
& git -C $secretaryRoot merge-base --is-ancestor $Branch main
if ($LASTEXITCODE -eq 0) {
  Invoke-Git branch -d $Branch
  Write-Output "브랜치 지움: $Branch (main에 합쳐짐)"
} else {
  Write-Output "브랜치 남김: $Branch (main에 아직 안 합쳐짐)"
}
