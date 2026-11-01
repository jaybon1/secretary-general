# 업데이트 프롬프트 (v1~v6을 쓰는 사람용, 처음 한 번)

v7부터는 비서에게 "업데이트 확인해 줘"라고만 하면 됩니다. v6 이하에는 그 기능이 없으니, 비서 세션에 아래 글을 그대로 붙여 넣으세요.

```
비서 업데이트를 해 줘. 순서대로:
1. 이 비서 폴더에서 `node src/cli.ts backup`으로 기억 DB를 먼저 백업하고, 백업 파일 경로를 알려 줘.
2. `git --version`으로 git이 있는지 보고, 없으면 멈추고 Git for Windows 설치를 안내해 줘.
3. `git clone https://github.com/jaybon1/secretary-general "$env:TEMP\secretary-update-<지금 날짜시각>"`으로 최신판을 임시 폴더에 받아.
4. 받은 폴더의 `.claude/skills/update/SKILL.md`를 읽고 그 순서를 1단계부터 그대로 따라 해. 이 폴더가 "사용자 폴더", 받은 폴더가 "받은 저장소"야(받은 저장소는 이미 있으니 다시 받지 마).
5. 내가 고친 곳은 지키고, 부딪히는 곳은 글로 물어봐. 기억 DB·models·node_modules·*.local.json·backups·작업 공간은 건드리지 마.
```
