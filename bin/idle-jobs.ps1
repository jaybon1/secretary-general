# 비서 진입점: 비서 폴더 밖에서는 이 고정 이름(진입점 폴더 bin의 idle-jobs.ps1. 진입점 폴더는 작업 공간에서는 맨 위 secretary-link.local.json의 bin, 없으면 환경변수 SECRETARY_<번호>_DIR 아래 bin)으로 부른다. 실제 스크립트: scripts/scheduled/idle-jobs.ps1
# 받은 인자를 그대로 넘기고 그 종료 코드로 끝난다. 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).
& "$PSScriptRoot\..\scripts\scheduled\idle-jobs.ps1" @args
if ($?) { exit 0 }
exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })
