---
name: consolidate
description: 아직 정리되지 않은 대화 로그를 기억(memories)과 핵심 프로필·큰 일 판으로 정리하는 기억 정리 담당을 띄운다. 평소에는 쉬는 시간 작업이 저절로 띄우고, 사용자가 /consolidate를 실행하거나 "기억 정리해줘"라고 할 때도 사용.
---

# 기억 정리 띄우기

기억 정리는 비서 대화 안에서 하지 않는다. 기억 정리 담당(설정 `src/staff/memory-consolidation.json`, 절차 `references/procedure.md`)이 비서 대화 밖 빈 폴더(`workspaces/_staff/memory-consolidation`)에서 따로 돈다. 쉬는 시간 정리와 같은 길이다.

1. 비서 폴더에서 `node src/cli.ts memory-consolidation --detach`를 한 번 돌린다. 정리를 떼어 띄우고 바로 끝난다.
   - "이미 도는 정리가 있어요"가 나오면 새로 띄우지 않은 것이다. 그 정리가 끝나기를 기다린다.
2. 사용자에게 한 줄로 알린다: 정리를 뒤에서 시작했고(길면 수십 분), 끝나면 다음 답에 "기억 정리 확인" 안내 줄이 붙으니 그때 "기억 정리 확인"만 보내면 결과를 함께 본다.
3. 절차를 직접 따라 하거나 기억 도구로 정리하지 않는다. 결과는 화면이 아니라 "기억 정리 확인"으로 본다.
