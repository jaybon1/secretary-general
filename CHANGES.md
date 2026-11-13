# 업데이트 내역

버전마다 새 기능, 바뀐 것, 고친 것, 올린 뒤 할 일을 적는다(최신이 위). 업데이트는 비서에게 "업데이트 확인해 줘"라고 하면 되고(README "업데이트"), 비서가 이 파일의 "올린 뒤 할 일"을 기준 버전 다음부터 차례로 함께 한다.

버전 번호: v0.9.0부터 0.x 세 자리(`v0.가운데.끝`)를 쓴다. 끝자리는 고친 것만, 가운데는 기능이 더해지거나 바뀐 것, 앞자리는 올린 뒤 사용자가 손봐야 하는 큰 변경이다(1.0.0 전까지는 앞자리를 0으로 둔다). 그 전의 v1~v8은 0.1.0~0.8.0으로 본다(v8 다음이 v0.9.0). 업데이트는 tag를 이 번호로 줄 세우고, 폴더의 `VERSION`이 `v8`처럼 옛 형식이어도 맞게 알아본다.

## v0.11.0

v0.10.0에서 올리면 기억(`secretary.db`), 검색 모델(`models/`), 작업 공간은 그대로 이어 쓴다. DB는 업데이트 뒤 처음 열 때 자동으로 맞춰진다(옮기기가 하나라도 있으면 그 전에 `backups/`에 자동 백업). 이번에 DB에서 바뀌는 것: 큰 일 판 표 이름(아래 "이름 정리"), 할 일 기억의 종류 `task` → `action`, 검수 대기(`review`)였던 업무는 끝남(`done`)으로, 결정 기억의 원문 발췌를 두는 표 `memory_quotes`가 새로 생기고, 실수 기록에서 추천 근거를 확인하지 않은 실수의 분류 이름 4개가 '확인 없이 추천' 하나로 합쳐진다. 기억과 대화 기록의 내용 글은 그대로다.

새 기능
- **기억 정리 판정을 프로그램이 실행:** 기억 정리 담당이 후보 기억마다 `propose_memory`로 가까운 기억 목록을 받고, 목록의 기억 하나하나에 `judge_memory`로 판정(관계 없음·같은 내용·바뀜·끝남, 그 일 한 번뿐인지 이어지는 사실인지)만 낸다. 저장·대체·건너뛰기는 그 판정대로 프로그램이 한다: 판정이 빠지거나 목록 밖 번호를 판정하면 거절하고, 앞뒤 비교는 근거 대화의 실제 시각으로 하고, 바뀐 기억에서 여전히 맞는 나머지는 새 기억으로 함께 저장한다. 두 도구는 정리 담당의 기억 서버에만 있고, 그 서버에서 `remember`는 주제 요약만 쓰고 `forget`은 쓸 수 없다.
- **기억 정리 보고의 개수를 프로그램이 셈:** 정리 보고 끝에 "[프로그램이 센 이번 정리 결과]" 줄(새 기억·대체·무효·주제 요약·주요 현안·프로필)과 새 기억 번호 줄이 붙는다. 모델이 센 숫자가 실제 DB와 다르던 일을 막는다. "기억 정리 확인" 때는 보고 목록에서 빠진 기억도 찾아 보여 준다.
- **결정 기억의 원문 발췌:** 결정을 저장할 때 `remember`의 `quote`에 사용자가 한 말을 글자 그대로 넣으면, 프로그램이 대화 기록에서 그 말을 찾아 몇 번 대화의 몇째 줄인지 붙인다(대화 중 저장은 Stop 훅이 그 턴을 저장한 뒤 확인하고, 못 찾으면 다음 질문에 알린다). 기억 주입과 `recall`에 "원문 #N M줄"로 보인다.
- **상황판의 미정 줄에 결정 대조:** 상황판의 "답 없음·미정" 줄마다 단어가 겹치는 결정 기억 1~2개를 붙인다. 다른 질문의 답 속에서 이미 정한 것을 "미정"으로 말하는 일을 막는다.
- **답변 검사 새 항목(모두 알림만, `warn`):** 추천 근거에 적은 파일·#번호·커밋·명령을 그 턴과 앞 두 턴에 실제로 열었는지(`basis-source`), 근거에 자료를 적고도 "안 봄"으로 쓴 것(`basis-unopened`)과 옛 근거 형식(`basis-old-form`), 업무 세션 보고의 경로를 열어 보지 않고 전한 것(`report-relay`), 비서가 지어내 사용자가 되물었던 말(`invented-word`, 목록은 `src/mistake-guards/invented-words.json`, `record_mistake`의 `invented_words`로 더한다. 목록의 `source`에는 그 낱말이 왜 들어갔는지 번호 없는 설명만 둔다: 배포판을 만든 비서의 실수·기억 번호는 받는 분의 기억 DB에 없는 번호라 뺐다), 다른 질문의 답에 기대는 질문을 같은 턴에 물은 것(`dependent-question`).
- **훅이 막거나 알린 것도 기록:** 폴더 쓰기 막기와 반복 작업 알림이 걸린 것을 턴 기록에 남기고, `list_mistakes` 끝에 최근 30일 훅별로 걸린 수를 붙인다.
- **훅 안내문 글을 파일로:** 상황판 읽는 법, 기억 정리 보고 때 할 일, 답 형식을 고치는 법, 의미 검색 실패 안내 등을 `.agents/hook-notices/`의 md 파일로 옮겼다. 훅은 그 글을 읽어 붙이기만 하므로 Claude Code·Codex·Antigravity가 같은 글을 쓴다(훅이 연결되지 않은 도구는 그 상황이 되면 비서가 그 파일을 직접 읽는다).
- **의미 검색 기다리기와 실패 기록:** 의미 검색 서버가 떠 있으면 30초, 꺼졌거나 모델을 불러오는 중이면 90초까지 기다린다. 서버가 답하지 않을 때마다 `~/.secretary/<번호>/logs/semantic-search-misses.jsonl`에 남기고, 2분 넘게 이어지면 질문 훅이 `<secretary-semantic-search-server>`로 알려 비서가 먼저 묻는다("단어 검색으로 답해"라고 하면 그 대화만 단어 검색으로 답한다). 정리 담당은 3분까지 기다리고 그래도 안 되면 정리를 멈춘다.
- **비서 코드 일을 작업 사본에서:** 비서 자신의 코드를 run-job으로 고치게 할 때 `bin/run-job-worktree.ps1`로 git worktree(작업 사본)를 만들어 그 안에서 고치게 한다. 고치는 도중의 코드가 비서 훅·예약 작업과 운영 DB에 닿지 않게 하기 위해서다. run-job 쓰는 법(폴더, 모델, 세션 재사용, 기다리는 법)은 새 `run-job` 스킬에 있다.
- **일 맡기기 지시의 의도·범위 밖·사용자 원문:** TASK.md·run-job·서브에이전트 지시에 이 세 항목을 두고, 보고에서 "묻지 않고 대신 정한 것·가정"을 받는다. `node bin/delegate-check.mjs brief`가 빈 항목을 알린다.
- **업데이트 마무리를 프로그램이:** 업데이트 끝에 `scripts/update.mjs finish`가 전에는 사람이 하던 두 일을 한다. `scripts/lib/providers.json`에서 `personalDataAllowed`가 없는 Claude 구독 공급자(`type`이 `claude-subscription`, 사용자 자신의 계정)에 `true`를 넣고(파일의 다른 줄과 형식은 그대로), `node src/cli.ts workspace-links`로 작업 공간의 규칙·링크를 지금 형식으로 맞춘다. 구독이 아닌 공급자(게이트웨이·API 키·다른 CLI)에는 값을 넣지 않고(값이 없으면 지금처럼 개인정보를 보내지 않는 공급자로 본다), 프로그램이 못 고친 공간과 함께 비서가 사용자에게 묻는다(올린 뒤 할 일 1·2).
- **설치 상태 점검 새 항목 `provider-personal-data`:** Claude Code 공급자(`type`이 `claude-`로 시작) 가운데 `providers.json`에 `personalDataAllowed`가 없는 것을 알린다. 알리기만 하고, 값은 사용자가 정한다. 구독 밖 공급자 예시(`feature-toggle` 스킬)의 게이트웨이에는 `"personalDataAllowed": false`를 적어 두었다.
- **개발:** `npm run test:changed`(바뀐 파일이 속한 기능의 테스트만 돌림), 실패한 테스트를 `~/.secretary/<번호>/logs/test-failures.jsonl`에 남김.

바뀐 것
- **이름 정리:** 큰 일 판은 **주요 현안**(진행 중·사용자 차례·보류·운영 중인 안건)으로 이름을 바꿨다. DB 표 `big_work` → `main_agenda`, MCP 도구 `set_big_work`·`list_big_work` → `set_main_agenda`·`list_main_agenda`, 세션 시작 때 붙는 글 `<secretary-big-work>` → `<secretary-main-agenda>`, v7에서 올릴 때 쓰는 명령 `big-work-from-profile` → `main-agenda-from-profile`(v8 "올린 뒤 할 일" 4도 새 이름으로 한다). 할 일 기억의 종류 `task` → `action`(화면 글 "할 일"은 그대로, 맡긴 업무 `tasks`와 구별). 쓰지 않던 실수 기록 칸 `mistakes.eval_ids`는 지웠다. 기억 내용 글은 그대로다. 옮겨진 파일은 업데이트가 따라간다(`scripts/update-moves.json`).
- **상황판 칸 이름:** 상황판 칸을 진행 중인 사항·사용자의 실행·확인·결정이 필요한 사항·보류한 사항·정한 사항·비서가 확인할 사항·바뀐 듯한 안건으로 바꿨다(지금 주제·풀린 듯한 질문은 그대로). 업데이트 끝에 상황판을 뒤에서 새 형식으로 다시 쓰고, 상황판 담당이 옛 칸 이름을 베껴 쓰거나 새 대화 없이 옛 판이 남아 있으면 코드가 칸 자리대로 새 이름으로 고친다. 고친 일과 못 고친 일은 상황판 담당의 실행 기록(`workspaces\_staff\situation-board\runs-<비서 번호>.jsonl`의 `headings`)에 남는다.
- **규칙(`AGENTS.md`) 다시 씀:** 제목과 짧은 항목으로 다시 쓰고 줄였다. 특정 상황의 절차는 훅 안내문과 스킬로 옮겼다. 새로 들어간 규칙: 한 턴 안의 순서(질문에 먼저 글로 답하고, 뒤에서 도는 일은 띄운 뒤 턴을 끝낸다), 다른 질문의 답에 따라 달라지는 질문은 다음 턴에 묻기, 말투(말로 할 법한 문장, 지어낸 말 쓰지 않기, 아는 분야는 현업 용어 그대로), 추천 근거 두 형식(`근거: 자료 있음, 못 봄(<무엇>, 이유: <못 연 이유>)`·`근거: 확인할 자료 없음(짐작)`), 압축 뒤 남은 질문, 압축할 때 요약에 남길 것(Compact Instructions), 같은 이야기는 `/compact`·다른 이야기는 `/clear` 제안. 낱말도 바꿨다(꼴 → 형식, 근거 줄 → 추천 근거, 질문 기호 → 질문 알파벳, 생각 깊이 → 추론 수준(effort) 등). `AGENTS.md`를 고쳐 쓴 사용자는 업데이트가 유지·덮어쓰기·섞기를 묻는다.
- **남은 질문은 "다음 행동 및 순서" 안에:** 답 끝 "다음 행동 및 순서:"의 번호 단계 하나로 `N. 남은 질문에 답해 주세요: A(뜻), …`를 쓴다(따로 떨어진 "남은 질문:" 줄과 "남은 질문: 없음" 줄은 없앴다). 그 단계가 없으면 열린 질문을 닫는다. 옛 "남은 질문:" 줄도 한동안 읽는다.
- **압축 뒤에도 상황판:** `/compact`(자동 압축 포함) 뒤 첫 질문에도 상황판과 그 뒤 원문이 붙는다. 남은 질문은 알파벳 그대로 이어진다.
- **답변 검사에서 뺀 것:** 두 PC 경로를 한 코드 블록에 쓴 것(`path-block`), 다음 행동 줄 빠짐(`next-action`), 남은 질문 줄 빠짐(`open-questions`), 로컬 미리보기 주소의 쿼리스트링(`path-preview`). 규칙 자체는 그대로다. `this-secretary.local.json`의 `mistake-guards` 키에 이 이름의 수준을 적어 두었으면 읽지 않는다(지워도 된다). 폰 링크 검사(`path-link`)는 링크 이름이 주소가 아니면 링크로 치지 않는다.
- **업무 검수 대기 없앰:** 비서가 업무 보고를 확인하면 바로 끝남으로 닫는다. `create_task`·`update_task`의 `review` 인자, `list_tasks`의 검수 대기 표시, 3일 뒤 다시 묻기, 대시보드 업무 칸반의 검수 대기 칸이 빠졌다. 검수 대기였던 업무는 끝남이 된다.
- **사용량 줄(다중 구독을 켠 사용자):** `<secretary-usage>`에는 사용률 숫자와 일을 보낼 계정만 보인다(넘기기 1~4단계와 단계별로 넘길 일 글을 뺐다). 무엇을 run-job으로 넘길지는 규칙의 "비싼 작업은 run-job으로"가 사용량과 상관없이 정한다. 보낼 구독이 모두 90% 이상이면 다른 계정·공급자로 돌릴지 먼저 묻는다.
- **공급자 개인정보 값:** 공급자에 개인정보를 보내도 되는지를 구독 여부 대신 `scripts/lib/providers.json` 공급자마다의 `personalDataAllowed`로 가른다. `true`인 Claude Code 공급자에서만 run-job·담당자에 비서 기억 도구가 붙고, `true`가 아니면 run-job을 비서 폴더에서 돌리지 못한다(Claude 구독 공급자는 업데이트가 `true`를 넣고, 나머지는 올린 뒤 할 일 1). 구독 밖 공급자 예시(`feature-toggle` 스킬)의 API 키 공급자 이름은 `anthropic-key` → `anthropic-api`(키 파일은 `keyFile` 형식 `anthropic-api-key-*.env`로 찾는다. 이미 `anthropic-key`로 쓰고 있으면 그 이름 그대로 `anthropic-key.env`로 돈다)로 바꿨고, Gemini CLI 자리는 뺐다.
- **기억 주입과 정리 지시:** 주입된 주제 요약 아래에 요약 뒤에 무효가 된 같은 주제 기억(대체한 번호와 함께)도 적는다. 정리 지시에 비서의 추천을 결정으로 적지 않기, 한 번 준 허락·예외는 그 일에 대한 event로 적기를 더했다.
- **작업 공간 규칙의 비서 관리 부분:** 공간 `AGENTS.md`와 run-job 기본 폴더 규칙에서 비서가 관리하는 절을 `<!-- secretary:begin <이름> -->` … `<!-- secretary:end <이름> -->`로 감싸고, `node src/cli.ts workspace-links`가 표시 안만 지금 틀대로 통째로 다시 쓴다. 공간 제목·이 공간이 하는 일·알아둘 맥락·검증 명령·사람이 더한 줄은 표시 밖에 그대로 둔다. 표시가 없는 옛 공간은 업데이트 끝에 프로그램이 한 번 옮기고, 틀 줄과 공간 몫을 확실히 가를 수 없으면 바꾸지 않고 알린다(그 공간은 올린 뒤 할 일 2).
- **DB 옮기기 전 백업:** 옮기기가 하나라도 돌 차례면 늘 먼저 백업한다(전에는 표를 다시 만드는 옮기기 앞에서만).
- **스킬·안내 글:** delegate·plan-grill·consolidate 스킬을 다듬었다(보고의 개수를 옮길 때 센 범위가 같은지 다시 세기, 완료 확인 방법마다 "한 번 시간 × 횟수", 업무 결과물이 이미 쓰였는지 먼저 찾기 등). 스크립트 출력과 설치 상태 점검의 낱말도 바꿨다("시험" → "테스트", "이어 부름" → "재사용", "입구 폴더" → "진입점 폴더" 등).
- **기록 번호 뺌:** 규칙·스킬·코드·테스트의 설명에 남아 있던, 배포판을 만든 비서의 실수·기억·대화 번호와 커밋을 뺐다(받는 분의 기억 DB에는 없는 번호다). 형식 예시의 번호(규칙의 질문 형식 예, 상황판 담당에게 주는 예)와 테스트 시험 자료의 번호도 지어낸 번호로 바꿨다. 동작은 같다.

고친 것
- 비서가 일하는 도중 사용자가 보낸(끼어든) 메시지가 대화 기록에 저장되지 않던 것. 이제 `[끼어든 말] …`로, 보낸 시각에 한 번 저장한다.
- "다음 행동 및 순서:" 줄에 이어 쓴 남은 질문 단계를 읽지 못하던 것, 상황판 질문 줄이 질문이 아닌 줄(예: "- PC: …")을 질문으로 잘못 읽던 것. 닫힌 질문은 이유(사용자가 답함·비서 답에서 빠짐·7일 지남·대화 지움)와 근거 번호를 7일 남긴다.
- 압축 직후 컨텍스트 크기 안내가 압축 전 마지막 호출 크기를 읽던 것.
- 공간 점검이 첫 문제에서 멈춰 같은 공간의 다른 문제를 가리던 것, CRLF로 저장된 공간 `AGENTS.md`에서 옛 글을 못 찾거나 고친 줄을 LF로 섞어 쓰던 것.
- `wait-job`이 일이 `out.txt`에 쓰는 도중에는 읽지 못하던 것.
- 업데이트에서 `features.json`(기능 목록)이 사용자 쪽과 부딪힐 때 스크립트 추천(`merge-new`)대로 정하면 사용자가 켜 둔 기능(예: 끝 알림 `phone-push`)이 꺼지던 것. 이제 유지·덮어쓰기·섞기 무엇을 골라도 사용자가 켜고 끈 값(`enabled`)은 사용자 것을 지키고, 설명·파일 목록 같은 나머지 칸은 고른 대로(추천이면 새 버전 것) 쓴다. 사용자가 받은 그대로 둔 기능은 새 버전 값을 따른다.

올린 뒤 할 일

업데이트 마무리(`scripts/update.mjs finish`, 업데이트 스킬 6단계)가 Claude 구독 공급자의 `personalDataAllowed`와 작업 공간 규칙 옮기기(`workspace-links`)를 이미 했다. 아래 1·2는 그 출력에 남은 것이 있을 때만 하고, 3은 언제나 마지막에 한다.
1. **구독이 아닌 공급자의 개인정보 값 정하기(해당 있을 때만):** 마무리 출력의 "물어볼 공급자"에 남은 공급자(외부 게이트웨이, API 키, Bedrock, 다른 CLI 등 `scripts/lib/providers.json`에서 `personalDataAllowed`가 없는 것)를 사용자에게 목록으로 보여 주고, 공급자마다 개인정보를 보내도 되는지 묻는다(사용자 자신의 유료 API 키·유료 계정은 `true`를 추천, 외부 게이트웨이·무료 플랜·무료 키는 `false`). 고른 대로 그 공급자에 `"personalDataAllowed": true`나 `false`를 넣는다. 값이 없는 동안은 개인정보를 보내면 안 되는 공급자로 본다: 그 공급자로 도는 run-job·업무 세션에는 비서 기억 읽기 도구가 붙지 않고, run-job을 비서 폴더에서 돌리지 못한다. 남은 공급자가 "없음"이면 "해당 없음".
2. **프로그램이 못 고친 작업 공간 정하기(해당 있을 때만):** 마무리 출력의 "물어볼 공간"(`workspace-links`의 "못 고침")에 남은 공간이 있으면 출력의 이유를 보여 주고 어떻게 할지 묻는다. 지금 템플릿에 있는 절이 없어서면 더하기로 한 공간만 `node src/cli.ts workspace-links --add-missing <공간 폴더 이름>`, 템플릿 줄과 비슷하지만 다른 줄이 있어서면 비서가 그 줄을 표시 안팎 어디에 둘지 사용자와 정해 그 공간 `AGENTS.md`에 표시를 직접 넣은 뒤 `node src/cli.ts workspace-links`를 다시 돌린다. 남은 공간이 "없음"이면 "해당 없음".
3. **새 세션 열기:** 1·2를 마친 뒤 마지막으로 사용자에게 새 세션을 열어 달라고 한다. 비서 기억 도구(MCP 서버 `secretary`)는 세션이 시작될 때 뜨므로, 도구 이름이 바뀐 이번 버전은 새 세션부터 새 도구로 돈다. 사용자 설정(`.claude/settings*.json`)에 옛 도구 이름(`mcp__secretary__set_big_work` 등)을 적어 두었으면 새 세션을 열기 전에 새 이름으로 고친다.

## v0.10.0

v0.9.0에서 올리면 기억(`secretary.db`), 검색 모델(`models/`), 작업 공간은 그대로 이어 쓴다. DB는 업데이트 뒤 처음 열 때 자동으로 맞춰지고 테이블 모양은 그대로다.

새 기능
- **반복 일 담당자:** 비서가 사람 없이 되풀이하는 일(기억 정리, 상황판 고쳐 쓰기)을 담당자마다 설정 파일 하나(`src/staff/<담당자>.json`: 공급자·모델·추론 수준(effort)·새 세션·기억 도구·허용/금지 도구·제한 시간·지시 파일)로 정하고, 비서 대화 밖 빈 폴더 `workspaces\_staff\<담당자>`(담당자용 짧은 역할 `AGENTS.md`와 실행 기록 `runs-<비서 번호>.jsonl`만 둔다)에서 `scripts/run-job/run-job.ps1 -Staff <담당자>`로 돌린다. 비서의 훅·규칙이 끼지 않고, 값을 따로 주면(`-Model` 등) 오류로 멈춘다. 옛 `run-job.ps1 -MemoryWrite`는 없어졌다.
  - **기억 정리 담당 `memory-consolidation`:** `/consolidate`와 쉬는 시간 정리가 같은 담당을 부른다(절차는 `consolidate` 스킬의 `references/procedure.md`). `/consolidate`는 정리를 뒤에서 띄우고 바로 끝나며, 결과는 화면이 아니라 다음 답의 안내 뒤 "기억 정리 확인"으로 본다. 이미 도는 정리가 있으면 새로 띄우지 않고, 정리하던 프로그램이 죽었으면 그 기록이 다음 정리를 막지 않는다. 쉬는 시간 작업을 꺼 두어도 `/consolidate`는 돈다.
  - **상황판 담당 `situation-board`:** 상황판 고쳐 쓰기(Haiku, 도구 없음, 기억 도구 없음, 묶음마다 3분). 전에는 run-job 기본 폴더에서 기억 읽기 도구를 단 채 돌았다.
- **호칭 설정:** 사용자를 부르는 이름을 DB에 값 하나로 둔다(`node src/cli.ts user-title <호칭>`, 인자 없으면 보기, `--clear`는 빼기). 규칙과 코드 글은 '사용자'로 쓰고, 그 이름으로 쓴 기억 글("<호칭>님은 …")을 기억 목록 라벨과 지시문 검사가 사용자로 읽는다. 넣지 않으면 '사용자'만 읽는다(지금과 같다).
- **결과물 경로 값 알림:** 다른 PC 경로(`this-secretary.local.json`의 `paths` 키의 `otherPcRoot`)나 대시보드 폰 주소가 있으면 세션 시작 때 `<secretary-paths>`로 이 PC 경로·다른 PC 경로·폰 주소가 붙는다(답변 검사와 같은 값). 둘 다 없으면 붙지 않는다.

바뀐 것
- **이 비서 설정 한 파일로:** 따로 있던 이 비서 설정 파일(`scripts/dashboard.local.json`, `scripts/usage.local.json`, `scripts/phone-push.local.json`, `scripts/mistake-guards.local.json`)을 비서 폴더 맨 위 `this-secretary.local.json` 하나에 기능별 키(`dashboard`, `usage-poll`, `phone-push`, `mistake-guards`, 다른 PC 경로는 `paths`)으로 모았다(예시 `this-secretary.local.example.json`). 기능을 끄면 그 키는 읽지 않는다. 업데이트가 옛 파일을 자동으로 옮기고(이미 있는 값은 덮어쓰지 않음), 옮긴 옛 파일은 지우지 않고 `backups/this-secretary-merge/`에 둔다(지울지는 올린 뒤 할 일 5에서 묻는다). 같은 PC에 비서가 둘이어도 같은 값을 써야 하는 설정은 비서 폴더가 아니라 PC 공용 `~/.secretary/all-secretaries.local.json`(키 폴더 옆, 예시 `all-secretaries.local.example.json`)에 둔다(지금 배포판 기능에는 그런 키가 없다).
- **작업 공간의 비서 위치 파일 이름:** 공간 맨 위 `secretary.json` → `secretary-link.local.json`(git 밖 파일임이 이름에 드러나게). `node src/cli.ts workspace-links`가 공간마다 새 파일과 `.gitignore` 줄을 쓰고, 공간 AGENTS.md의 찾는 코드를 새 이름으로 고친다. 옛 `secretary.json`은 지우지 않고 새 파일과 같게 맞춰 두어, 옛 찾는 코드를 복사해 둔 공간 도구도 그대로 돈다(다음 버전에서 옛 이름은 뺀다).
- **스킬 사양(agentskills.io)과 공통 스킬 이름:** 스킬은 agentskills.io 사양을 따른다. 머리말(`---`)의 `name`은 폴더 이름과 같고, `SKILL.md`(500줄 미만)에는 원칙과 "언제 어느 파일을 읽을지"만 두고, 세부는 `references/`, 스킬이 쓰는 코드는 `scripts/`, 템플릿·설정·데이터는 `assets/`에 둔다. 설치 상태 점검(`setup-check`)과 `npm test`가 사양을 검사한다. 남이 만든 설치본·가상환경은 스킬에 넣지 않고 `%USERPROFILE%\tools`에 둔다. 공통 스킬은 폴더·목록·링크·`name`이 모두 `common-<이름>`이다(`workspaces\_skills\common-<이름>\`, `common-skills.json`에도 `common-`까지 적는다). 옛 형식(목록에 접두어 없음, 폴더 `_skills\<이름>\`)은 `skill-links`·`workspace-links`가 새 이름으로 옮긴다(올린 뒤 할 일 2).
- **작업 공간 옆 보조 폴더 이름:** `workspaces` 안에서 작업 공간이 아닌 보조 폴더는 밑줄로 시작한다(`_skills`, `_sandbox`, `_run-job-home`, `_archived`, `_staff`). run-job 기본 폴더 `run-job-home`은 `_run-job-home`, 보관한 공간을 두는 `old`는 `_archived`로 바뀐다(올린 뒤 할 일 1). run-job 기본 폴더가 없으면 설치 상태 점검(`workspace-aux-folders`)이 규칙(`AGENTS.md`)과 함께 만들고, 그래도 없으면 run-job은 임시 폴더로 가지 않고 오류로 멈춘다.
- **꺼 둔 기능의 스킬 위치:** 꺼 둔 기능의 스킬(`calendar`)은 머리말(`---`)의 `disable-model-invocation` 줄 대신 위치로 막는다. 꺼져 있는 동안은 어느 CLI도 읽지 않는 `.agents/skills-off/<이름>/`에 두고, 켜면 `node src/cli.ts skill-links`가 `.agents/skills/<이름>/`으로 폴더째 옮긴다(끄면 되돌린다, 고친 내용은 함께 간다). 업데이트는 사용자의 `features.json`대로 그 스킬을 제자리에 두고 옛 머리말 줄을 뺀다(내용이 그 줄만 다른 파일도 사용자 폴더에서 그 줄을 지운다).
- **이름 정리:** 한 단어가 두 뜻으로 쓰이거나 뜻이 드러나지 않던 이름을 바꿨다. 업데이트가 옮겨진 파일을 따라가고(`scripts/update-moves.json`), 아래 이 PC 파일과 기능 이름도 자동으로 옮긴다.
  - 스킬: `grill` → `plan-grill`(계획 빈틈 파고들기), `features` → `feature-toggle`(기능 켜고 끄기), `handoff` → `session-handoff`(세션 이관, `/session-handoff`), `update` → `secretary-update`(비서 업데이트).
  - 기능 이름(`features.json`): `memory` → `memory-core`, `board` → `session-continuity`, `consolidate` → `memory-consolidation`, `backup` → `db-backup`, `providers` → `external-providers`, `notify` → `phone-push`, `account-handoff` → `multi-subscription`(다중 구독), `guards` → `mistake-guards`(실수 막기 장치), `update` → `secretary-update`(업데이트, 스킬 이름과 같게). 켜 두거나 꺼 둔 것은 그대로 이어진다(업데이트가 새 이름에 옮겨 적는다). 기능마다의 예약 작업 키 `tasks`는 `scheduledTasks`(맡긴 업무 task와 구별).
  - 명령: `node src/cli.ts stats` → `memory-stats`, `backup` → `db-backup`, `ingest` → `ingest-transcript`, `catch-up` → `catch-up-transcripts`, `board` → `situation-board-show`, `board-update` → `situation-board-update`, `workspace-folders` → `workspace-aux-folders`, `handoff-wake` → `session-handoff-wake`, `handoff-account` → `subscription-pick`, `embed-server` → `semantic-search-server`, `secretary-idle-jobs` → `idle-jobs`, 기억 정리를 바로 돌리는 `secretary-idle-jobs --consolidate-now [--detach]` → 따로 된 명령 `memory-consolidation [--detach]`(`/consolidate`가 부른다).
  - 예약 작업: 끝 알림 ntfy 서버 `Secretary ntfy (번호)` → `Secretary ntfy Server (번호)`(켠 사용자만, 올린 뒤 할 일 3).
  - 이 PC 파일: 끝 알림 설정 `scripts/notify.local.json` → `scripts/phone-push.local.json`, 설치 상태 점검 기록 `secretary.db.setup.json` → `secretary.db.setup-check.json`, 답변 검사 설정 `scripts/guards.local.json` → `scripts/mistake-guards.local.json`, 의미 검색 서버의 DB 옆 파일 `secretary.db.embedder*` → `secretary.db.semantic-search-server*`(업데이트 적용 때 옮긴다, 새 이름 파일이 이미 있으면 옛 파일을 그대로 두고 알린다. 답변 검사 설정과 의미 검색 서버 파일은 그 뒤에도 옛 이름 파일이 남아 있으면 설치 상태 점검 `renamed-local-files`가 알린다. 남은 옛 이름 파일을 지울지는 올린 뒤 할 일 5에서 묻는다).
  - 설치 상태 점검 항목: `packages` → `npm-packages`, `model` → `semantic-search-model`, `secretary-dir` → `secretary-dir-env`, `notify` → `phone-push`, `workspace-folders` → `workspace-aux-folders`(옛 이름으로 빼 둔 항목도 그대로 빠져 있다). 질문 알림 `<secretary-context>` → `<secretary-context-size>`, `<secretary-labels>` → `<secretary-question-label>`, `<secretary-embedder>` → `<secretary-semantic-search-server>`, `<secretary-guard>` → `<secretary-answer-check>`.
  - 환경변수: 의미 검색을 끄는 `SECRETARY_EMBED=off` → `SECRETARY_SEMANTIC_SEARCH=off`, `SECRETARY_EMBED_IDLE_MIN`·`_MODEL_DIR`·`_MODEL_REPO` → `SECRETARY_SEMANTIC_SEARCH_IDLE_MIN`·`_MODEL_DIR`·`_MODEL_REPO`, 사용량 정지 기준 `USAGE_PAUSE_PCT` → `SECRETARY_USAGE_GUARD_PCT`(모두 옛 이름도 한동안 읽는다).
  - 폴더: `scripts/server` → `scripts/remote-server`(Windows 알림 `notify.ps1` → `windows-toast.ps1`), `src/board` → `src/session-continuity`, `src/notify`·`scripts/notify` → `phone-push`, `src/semantic`·`scripts/semantic` → `semantic-search`(의미 검색 서버 `semantic-search-server.ts`, 모니터링 `watch-semantic-search-server.mjs`), `src/guards` → `src/mistake-guards`, `scripts/tasks` → `scripts/scheduled`(예약 작업 등록 `install-tasks.ps1` → `install-scheduled-tasks.ps1`), 업무 세션 훅 `worker-guard.mjs` → `worker-folder-guard.mjs`, 그 밖의 파일 이름 몇 개. 예약 작업은 `bin\`의 같은 이름 진입점을 부르므로 다시 등록하지 않아도 된다. 옛 위치에서 뜬 비서 서버 창도 다시 켤 때 같은 창으로 찾는다.
  - 비서 고유 번호: 새로 만드는 번호는 모음(A·E·U·Y)을 쓰지 않는다. 이미 있는 번호는 그대로 쓴다.
  - 사용자 폴더의 기록 위치(`%USERPROFILE%\.secretary`): 이 PC의 비서들이 함께 쓰는 것은 바로 아래 단어 이름(`keys`, `usage`, `ntfy`), 비서마다의 것은 고유 번호 폴더 아래(`<번호>\logs`, `<번호>\state`). 사용량 기록 `~/.claude/usage` → `~/.secretary/usage`(Claude Code 자체 폴더 안이라 비서 것임이 드러나지 않았다. 옛 폴더에 쓰는 옛 사본이 있는 동안 정지 훅·대시보드는 두 곳 가운데 새 기록을 읽는다), "90% 넘어도 진행" 풀기 `guard-override-<계정>.json` → `usage-guard-override-<계정>.json`(옛 풀기도 초기화 시각까지 읽고 지난 것은 지운다), 정지 장치 끄기 파일 `~/.claude/usage-guard-off` → `~/.secretary/usage-guard-off`(옛 위치도 한동안 읽는다), 기록 `logs\<번호>` → `<번호>\logs`(옛 기록은 그 자리에 둔다), `state\<번호>` → `<번호>\state`(업무 세션·run-job 기록은 첫 세션에 새 위치로 옮겨 온다, 옛 파일은 그대로 둔다).
- **규칙(`AGENTS.md`):** 사용자를 부를 때는 핵심 프로필의 호칭을 쓰고 규칙·스킬 글의 "사용자"는 그 사람을 가리킨다는 줄, 누가 하는 일인지는 "비서가 직접"·"사용자가 직접"·"프로그램이 자동으로"처럼 주어로 쓴다는 줄, 대화 크기 알림(`<secretary-context-size>`)이 없으면 대화 크기를 숫자로 말하지 않는다는 줄이 들어갔다. 그 밖에는 위 이름 정리에 맞춘 단어만 바뀌었다. `AGENTS.md`를 고쳐 쓴 사용자는 업데이트가 유지·덮어쓰기·섞기를 묻는다.

고친 것
- 비서 서버가 꺼져 있을 때 run-job 안의 기억 도구가 의미 검색 서버를 띄우면, 의미 검색 서버가 run-job을 부른 쪽의 출력 통로를 물려받아 run-job이 끝나도 부른 쪽(쉬는 시간 정리 등)이 의미 검색 서버가 꺼질 때(기본 60분)까지 기다리던 것. 의미 검색 서버는 이제 아무 통로도 물려받지 않게 띄운다.
- 업데이트가 옮기거나 지운 파일의 옛 폴더가 빈 채 남던 것. 이제 비게 된 폴더를 함께 지운다(사용자 파일이 남아 있는 폴더는 그대로 둔다). 이름이 바뀐 스킬의 옛 폴더(`.agents/skills/grill` 등)가 `SKILL.md` 없이 남아 설치 상태 점검 `skills`와 스킬 사양 테스트에 걸리는 일을 막는다.
- 사용자가 기능을 켜거나 끈 폴더에서 `npm test`의 시험 3개(배포판이 낸 켜짐·꺼짐 상태를 기대하던 것)가 실패하던 것. 이제 `features.json`이 배포판 그대로일 때만 그 상태를 본다.
- 공간 규칙에 든 파이썬 비서 찾기 코드(`secretary_bin`)가 비서 위치 파일도 환경변수도 없을 때 `TypeError`로 죽던 것. 이제 "비서 진입점을 못 찾음"이라는 글로 멈추고, 이미 있는 공간 규칙의 옛 형식은 `node src/cli.ts workspace-links`가 고친다(설치 상태 점검 `workspace-links`가 고칠 공간을 알린다).

올린 뒤 할 일 (v0.9.0에서)
1. **보조 폴더 옮기기:** 비서 폴더에서 `node src/cli.ts workspace-aux-folders --dry-run`으로 옮길 것을 보고, 사용자에게 보여 준 뒤 `node src/cli.ts workspace-aux-folders`를 돌린다. `workspaces\run-job-home`·`workspaces\old`가 있으면 `_run-job-home`·`_archived`로 옮기고(옛 이름 링크는 남기지 않는다), DB에 `old\` 아래로 적힌 보관 공간의 폴더를 `_archived\`로 고치고, 담당자 폴더 `_staff\memory-consolidation`·`_staff\situation-board`를 만들고, `_run-job-home`이 없으면 규칙과 함께 만든다. 옛 폴더가 없으면 담당자 폴더와 `_run-job-home`만 생긴다. 옮기다 실패하면(그 폴더를 쓰는 중) 그 일을 끝낸 뒤 다시 돌린다.
2. **공통 스킬 이름 맞추기:** 비서 폴더에서 `node src/cli.ts skill-links --dry-run`과 `node src/cli.ts workspace-links --dry-run`으로 고칠 것을 보고, 사용자에게 보여 준 뒤 `--dry-run` 없이 돌린다. 접두어 없이 적힌 `common-skills.json` 목록은 `common-`을 붙여 다시 쓰고, `workspaces\_skills\<이름>\`에 있던 공통 스킬은 `_skills\common-<이름>\`으로 옮겨 `SKILL.md`의 `name`을 맞춘다. 공통 스킬을 쓰지 않으면 "해당 없음".
3. **ntfy 서버 예약 작업 이름 옮기기(끝 알림을 켠 사용자만):** 비서 폴더에서 `scripts/scheduled/install-scheduled-tasks.ps1 -Task ntfy -DryRun`으로 `옮김(예정): 'Secretary ntfy (번호)' → 'Secretary ntfy Server (번호)'` 줄을 보고, 사용자에게 보여 준 뒤 `-DryRun` 없이 돌린다. 새 이름으로 등록하고 옛 작업을 지운다(옛 작업의 `ntfy.exe`·`server.yml` 위치와 사용 안 함 상태를 이어받는다, 옮기는 이름은 `scripts/update-moves.json`의 `scheduledTasks`). 끝 알림을 꺼 두었으면 "해당 없음".
4. **이 비서 설정 옮기기 확인:** 업데이트 출력에 "이 비서 설정 한 파일로 … 그대로 둠"이 있으면 `this-secretary.local.json`의 그 키에 이미 다른 값이 있거나 옛 파일이 JSON이 아닌 것이다. 두 값을 비교해 사용자에게 보여 주고, 정한 값을 그 키에 쓴 뒤 `node src/cli.ts this-secretary-merge`를 다시 돌린다(설치 상태 점검 `renamed-local-files`도 남은 파일을 알린다).
5. **남은 옛 이름 파일을 지울지 묻기:** 1~4를 마친 뒤 비서 폴더에서 `node src/cli.ts setup-check`를 돌려 `renamed-local-files`(이름이 바뀐 이 PC 파일) 항목이 알리는 옛 이름 파일과 업데이트 적용 출력의 "새 이름 파일이 이미 있어 옛 파일을 그대로 둠" 줄에 나온 파일을 보고, `backups\this-secretary-merge\`에 옮겨 둔 옛 설정 파일도 함께 목록으로 사용자에게 보여 준다. 옛 이름 파일은 파일마다 새 이름 파일(또는 `this-secretary.local.json`의 그 키)와 비교해 옛 파일에만 있는 값이 있으면 먼저 보여 주고 새 위치에 옮길지 묻는다. 그런 뒤 목록의 파일을 지울지 묻고, 지우기로 한 파일만 지운다(새 이름 파일과 `this-secretary.local.json`은 건드리지 않는다). 작업 공간의 옛 `secretary.json`은 이 버전에서 아직 읽히므로 지우지 않는다. 남은 파일이 없으면 "해당 없음".

## v0.9.0

v8에서 올리면 기억(`secretary.db`), 검색 모델(`models/`), 작업 공간은 그대로 이어 쓰고 DB 형식도 바뀌지 않는다.

새 기능
- **다중 구독(꺼짐, 옛 이름 '두 번째 구독'):** 일을 보낼 구독을 둘 이상(계정 b, c, …) 둘 수 있다. 매 질문의 사용량 줄에 모든 구독의 사용률과 일을 보낼 계정이 붙고, 보낼 계정은 계정 a 밖의 구독 중 5시간 사용률이 가장 낮은 것이다(5시간·주간 90%를 넘은 계정은 빼고, 조회 기록이 없는 계정은 다른 계정에 기록이 없을 때만). `scripts/lib/providers.json`의 `"default"`를 `"auto"`로 두면 업무 세션·run-job을 띄울 때마다 그 규칙으로 계정을 고르고(`node src/cli.ts handoff-account`가 지금 고를 계정을 알려 준다), "계정 c 90퍼 넘어도 진행"처럼 계정을 적어 풀 수 있다. 구독이 둘(a·b)뿐이면 줄과 고르기가 전과 같다. 켜는 순서는 `features` 스킬의 `account-handoff`.

바뀐 것
- **지시서 대조(`bin/delegate-check.mjs`):** 일을 맡기기 전 대조가 그 공간 스킬(`SKILL.md`)에서 지시서와 단어가 겹치는 규칙 줄을 점수 순 위 10줄 보여 준다(`--rules`). 지시서에 빠진 듯한 결정 기억도 지시서와 단어가 겹치는 점수 순 위 10개만 보여 주고(`--memories`), 겹치는 단어가 없는 결정은 빠진 것으로 세지 않는다.
- **질문 알파벳 세기:** 다음 질문 알파벳은 질문 줄("A. …?", "A(뜻). …?", 새 세션 첫 답에서 다시 보여 주는 "A(옛 G, #4508). …?")만 보고 센다. "남은 질문:" 줄은 알파벳을 올리지 않고, 그 줄은 괄호 속 뜻을 빼고 항목마다 맨 앞의 알파벳만 읽어 질문을 닫거나 다음 세션으로 넘긴다.
- **새 작업 공간의 `.gitignore`:** 큰 영상·소리 파일(`*.mp4` `*.mov` `*.mkv` `*.webm` `*.wav` `*.mp3` `*.m4a` `*.flac` `*.aac`)을 공간 기록(git)에 넣지 않는 줄이 들어간다. 원본은 백업으로 지키고 기록에는 코드·대본·설정·보고서와 작은 그림만 남긴다. 이미 있는 공간은 그대로다(올린 뒤 할 일 1).
- **작업 공간 zip 묶기 뺌:** 작업 공간의 규칙·스킬만 골라 zip으로 묶던 기능(`scripts/export/`의 스크립트 두 개와 그 시험)을 뺐다. v8에서 올리면(v7에서도) 업데이트가 사용자가 안 고친 그 파일들을 지우고, 고친 것만 지울지 묻는다.
- **안내 글:** 네트워크 공유·끝 알림에 붙어 있던 "실행 확인 안 됨" 표시를 뺐다. README의 "다음 단계 후보"를 지웠다. `SECRETARY_EMBED_IDLE_MIN` 설명을 고쳤다: 비서 서버가 꺼져 있을 때 켜진 의미 검색 도우미가 기다리다 꺼지는 시간이고, 서버가 떠 있으면 도우미는 서버와 함께 떠 있다가 서버가 꺼지면 따라 꺼진다.
- **버전 번호와 업데이트:** 위 "버전 번호"대로 0.x 세 자리로 바꿨다. 업데이트 도우미(`scripts/update.mjs`)가 tag를 번호로 줄 세워(옛 git 이름 정렬은 v0.9.0을 v1보다 앞에 두었다) v7·v8 폴더도 v0.9.0을 최신으로 찾고, 출력에 "기준 v8(0.8.0) → 최신 v0.9.0"처럼 옛 tag의 0.x 번호를 함께 적는다.

고친 것
- "남은 질문:" 줄의 뜻 속 대문자(예: "F(새PC 단계)"의 PC)를 질문 알파벳으로 읽어, 다음 질문 알파벳이 F에서 PD로 건너뛰고 없는 질문이 열린 채 다음 세션으로 넘어가던 것.

올린 뒤 할 일 (v8에서)
1. **(영상·소리를 다루는 작업 공간이 있으면) 그 공간의 `.gitignore`:** 비서가 `../workspaces/*/.gitignore`에서 위 줄이 없는 공간을 찾아 보여 주고, 영상·소리 파일을 만드는 공간에만 넣을지 사용자에게 묻는다. 승인받으면 주석 한 줄(`# 큰 영상·소리 파일: 원본은 백업으로 지키고 기록에는 코드·대본·설정·보고서와 작은 그림만 남긴다`)과 확장자 줄을 끝에 붙인다. 이미 기록에 들어간 파일은 그대로 둔다(기록에서 빼려면 공간마다 따로 정한다). 그런 공간이 없으면 "해당 없음".

## v8

기억(`secretary.db`), 검색 모델(`models/`), 작업 공간은 그대로 이어 쓴다. DB는 처음 켤 때 자동으로 새 형식으로 바뀐다(큰 변경 전에는 DB 사본을 `backups/`에 먼저 만든다). 검색 모델 위치가 v7과 같아서 다시 받거나 다시 색인하지 않는다.

새 기능
- **기능 목록과 켜고 끄기:** 비서 폴더 맨 위 `features.json`에 기능마다 파일·설치 상태 점검·알림·예약 작업·규칙 위치를 적는다. 처음엔 꺼 둔 기능을 비서에게 "○○ 켜 줘"라고 하면 무엇이 생기는지 알리고 승인받아 켠다(`features` 스킬). 꺼 둔 기능: 일정(Google Calendar), 메모 볼트(`../notes`), 받은 파일 폴더(`../inbox`), 다른 PC에서 보는 네트워크 공유, 두 번째 구독으로 일 보내기(사용률에 따라 계정 a에서 b로 자동으로), 구독 밖 공급자(API 키, Bedrock, 게이트웨이, 다른 회사 CLI), 대시보드, 끝 알림.
- **쉬는 시간 작업(켜짐):** 예약 작업 'Secretary Idle Jobs (번호)'가 5분마다 돌아, 대화가 10분 멈추면 상황판을 미리 고쳐 쓰고, 정리 안 된 대화가 60건 넘고 30분 멈추면 기억 정리를 돌린다(같은 구독의 Haiku). 정리가 끝나면 답 끝에 안내가 붙고, "기억 정리 확인"만 보내면 비서가 결과를 함께 본다.
- **실수 막기 장치(켜짐):** 답이 영어로 새거나 끝맺음 줄(다음 행동 및 순서, 남은 질문, 추천 근거(`> 근거:` 줄))이 빠지면 Stop 훅이 한 번 되돌려 그 자리에서 고쳐 쓰게 한다. 질문 알파벳은 훅이 다음 글자를 알려 주고, 비서 상위 폴더 바로 아래·`temp`에 쓰는 것을 막고, 같은 조작을 한 턴에 여러 번 되풀이하면 도구로 한꺼번에 할지 따져 보라고 알린다. 일을 맡길 때 지시서·보고를 기억·실제 파일과 대조하고(`bin/delegate-check.mjs`), 걸린 실수는 실수 기록(`record_mistake` 등)에 남는다. 수준은 `scripts/guards.local.json`으로 바꾼다.
- **사용량 뒤에서 조회(켜짐):** 비서 서버가 켜져 있는 동안 구독 사용량을 5분마다 토큰 없이 새로 읽는다(`node src/cli.ts usage-poll`, 이 PC에 하나만). 대화를 쉬는 동안에도 정지 장치·상태줄이 새 값을 본다. 끄려면 `features` 스킬.
- **대시보드(꺼짐):** 한도·돌고 있는 일·업무 칸반·예약 작업을 보는 웹 화면, 한도에 보일 공급자 고르기(`/settings`), 결과물 폴더를 폰 브라우저로 읽기 전용으로 보기(`/share`). 다른 기기에서는 Tailscale 같은 사설망으로 연다.
- **끝 알림(꺼짐):** 답이 끝날 때마다 첫 줄을 이 PC의 ntfy 서버로 보내 폰 앱에 띄운다. 설치 스크립트 `scripts/notify/install-ntfy.ps1`이 로그인 때 띄우는 예약 작업을 등록하고, `-WebPush -WebPushEmail <메일>`이면 PC 브라우저 웹 푸시 키도 만든다(개인 키는 `server.yml`에만).
- **큰 일 판:** 몇 달 가는 큰 일의 상태(진행 중 / 사용자 차례 / 보류 / 운영 중)를 프로필에서 따로 떼어 DB의 판으로 둔다. 세션을 열 때 판이 붙고, 상태가 바뀌면 비서가 그 줄만 고친다(이력이 남는다).
- **대화 지우기:** `비서 대화 삭제 2턴`, `비서 대화 삭제 #번호`, `비서 대화 삭제 #번호-#번호`라고 보내면 지울 대화를 단어 첫 글자로만 미리 보여 주고 승인 코드를 준다. 30분 안에 코드만 보내면 AI를 거치지 않고 지운다. 지운 대화는 `backups/error/`의 격리 DB로 옮겨지고 비서는 읽지 않는다.
- **되감기 정리:** Claude Code에서 되감기(rewind)로 버린 갈래의 대화가 기억·상황판에 남지 않게 정리한다.
- **바깥에서 부르는 고정 진입점 `bin/`과 환경변수 `SECRETARY_<번호>_DIR`:** 비서 폴더 밖(예약 작업, 사용자 설정의 훅·상태줄, 작업 공간 도구)은 `bin/`의 이름으로만 비서 스크립트를 부른다. 스크립트 위치가 바뀌어도 바깥을 다시 등록하지 않아도 된다. 작업 공간 도구는 비서 진입점 폴더를 공간 맨 위 `secretary.json`(비서가 써 두는 진입점 폴더 `bin`과 번호, 비서 폴더 자체는 적지 않는다, 공간 git에는 넣지 않는다)으로 찾고, 없으면 그 비서 번호가 든 환경변수(예: `SECRETARY_A3F9_DIR`) 아래 `bin`으로 찾는다. 찾는 함수(Python·PowerShell·Node)는 공간 규칙에 들어 있다. 업무 세션의 셸 명령은 비서 폴더를 `bin\<이름>` 부르기로만 쓸 수 있다(비서의 다른 파일을 열거나 실행하거나 쓰는 명령은 업무 세션 훅이 막는다).
- **비서 고유 번호:** 설치마다 짧은 무작위 번호(예: `A3F9`, 대문자)를 처음 한 번 만들어 비서 폴더 `.secretary-id`에 두고 계속 쓴다(업데이트·배포판에 들어가지 않고 덮이지 않는다). 예약 작업 이름(`Secretary Idle Jobs (A3F9)`)과 비서 폴더 환경변수(`SECRETARY_A3F9_DIR`)에 붙어 한 PC에 비서가 여럿이어도 겹치지 않는다. 다른 폴더의 비서가 같은 번호면 이 비서를 옮기거나 복사하고 남은 사본으로, 다르면 다른 비서로 본다.
- **업데이트:** 사용자가 고쳤고 새 버전도 바꾼 파일은 깨끗이 합쳐져도 파일마다 유지·덮어쓰기·섞기를 묻는다(많으면 "나머지는 추천대로"). 버전 사이에 옮겨진 파일을 따라가 옛 위치의 사용자 수정을 새 위치로 합친다(`scripts/update-moves.json`). 최신판 받기는 따로 된 명령으로 하고, Claude Code 자동 모드에 막히면 다시 시도하지 않고 직접 칠 명령을 알려 준다. 적용 전에 바꿀 파일 개수를 한 줄로 보여 주고, "올린 뒤 할 일"은 빠짐없이 번호 순서대로 하며 건너뛰는 것은 이유를 말한다.
- **배포판 파일 목록 `release-files.json`:** 이 버전이 넣은 파일마다 내용 해시를 적은 목록이 폴더 맨 위에 들어간다(배포판을 만들 때 생긴다). 다음 버전으로 올릴 때 업데이트가 사용자가 고친 파일을 이 목록으로도 가리고(받았던 판이 저장소 tag와 조금 달라도 안 고친 파일을 묻지 않는다), 테스트의 PowerShell 검사가 비서 파일과 사용자가 만든 스크립트를 이 목록으로 가르고(비서 폴더 안에 만든 스크립트도 경고만), 설치 상태 점검이 빠진 비서 파일을 알린다. v7에서 올라올 때는 v7에 목록이 없어 예전처럼 tag와 비교한다.

바뀐 것
- **스킬 위치 `.agents/skills/`:** 비서의 스킬은 맨 위 `.agents/skills/<이름>/SKILL.md`에 실제 폴더로 한 벌만 둔다(Codex·Antigravity가 이 위치에서 읽는다). Claude Code가 읽는 `.claude/skills`는 그리로 가는 링크(Windows 디렉터리 정션, 관리자 권한 필요 없음) 하나이고, `node src/cli.ts skill-links`가 만들고 고친다(`--dry-run`은 보기만). 링크는 zip·git에 들어가지 않아 설치할 때(README 설치 6번)와 폴더를 옮긴 뒤 한 번 돌린다. 설치 상태 점검의 '스킬' 항목이 빠지거나 어긋난 링크를 알리고, 링크 위치에 실제 폴더가 있으면 지우지 않고 알리기만 한다. 사용자가 만드는 스킬도 `.agents/skills/<이름>/`에 둔다. 작업 공간도 같은 구조이고, 여러 공간이 함께 쓰는 스킬(`workspaces\_skills\<이름>\`)은 공간 맨 위 `common-skills.json`에 적으면 `common-<이름>`으로 링크된다.
- **폴더 정리:** `src/`와 `scripts/`를 영역별 폴더로 나눴다(`src/store`, `src/memory`, `src/hooks`, `scripts/server`, `scripts/tasks`, `scripts/worker` 등, README "구조"). 큰 파일 여럿을 나눴다.
- **예약 작업 등록 하나로:** 비서 서버 자동 시작·매일 백업·쉬는 시간 작업을 `scripts/tasks/install-tasks.ps1 -Task server|backup|idle-jobs`로 등록한다(옛 `install-autostart.ps1`, `backup-db.ps1 -Install` 대신). 매일 백업 기본 시각은 22:30(`-At`으로 바꿈).
- **UAC 안내:** 설치 맨 앞에 "밖에서 쓰는 동안 UAC 확인 창이 뜨면 일이 멈추니 비서 서버 자동 시작(설치 8번)을 꼭 하라"는 안내를 넣고, "UAC를 가장 낮게(알리지 않음)" 단계는 뺐다. 자동 시작으로 띄운 서버는 가장 높은 권한으로 돌아, Windows 기본보다 한 단계 낮춘 UAC(화면 어둡게 하지 않음)에서도 확인 창 없이 관리자 일(파일 쓰기, 예약 작업 등록·삭제)을 하는 것을 확인했다. 이미 "알리지 않음"으로 낮춘 사람은 원하면 기본값으로 되돌려도 된다.
- **답 끝 "다음 행동 및 순서":** 할 일이 여럿이면 끝까지 번호 붙여 순서대로 적는다. 할 일이 없는데 뒤에서 일이 돌고 있으면 기다리면 된다는 말과 다른 시킬 일을 말해 달라는 말을 함께 적는다.
- **답 규칙:** 말하거나 추천하기 전에 확인할 수 있는 것은 그 자리에서 확인한다(확인은 아끼지 않는다). 추천 선택지 바로 아래에 인용 줄 `> 근거:`로 확인한 근거를 붙이고, 질문은 그 질문을 부른 설명 바로 뒤에 두며, "남은 질문:" 줄에는 알파벳마다 짧은 뜻을 붙인다. 결과물 경로는 경로 하나마다 코드 블록 하나에 쓴다.
- **검수 대기:** 사용자가 결과물을 직접 봐야 끝나는 업무는 "검수 대기"로 두고, 3일이 넘으면 새 세션·기억 정리 때 다시 묻는다(그동안 그 공간의 다음 업무는 맡길 수 있다).
- **상황판의 "답 없음·안 함·미정":** 그렇게 말하기 전에 기억과 대조한다(상황판은 기억을 보지 못한다).
- **기억 정리 확인 문구:** "기억 정리 확인"만 보냈을 때만 정리 결과가 온다(띄어쓰기는 상관없다).
- **서브에이전트:** 기억·판단이 많이 드는 조사·검토는 비서가 직접 하거나 비서 세션의 서브에이전트에 맡기고, 서브에이전트는 기억 읽기 도구만 쓰고 저장은 보고의 "기억할 것"으로 넘긴다. 업무 세션·run-job에도 기억 읽기 도구(`recall`·`search_log`)가 붙는다.
- **사용량 기록은 계정별, 비서 기록은 비서 번호별:** 구독 사용량 파일 이름에 그 공급자로 로그인한 계정(메일 @ 앞부분)이 붙는다(`~/.claude/usage/subscription-<계정>.json`). 로그인을 다른 계정으로 바꿔도 옛 계정의 사용량을 새 계정 것으로 보지 않는다. 계정 없는 옛 이름 파일은 새 이름으로 처음 쓴 뒤 자동으로 지워진다. 서버·쉬는 시간 작업·끝 알림 기록은 `~/.secretary/logs/<비서 번호>/` 아래에, 업무 세션·run-job·뒤에서 띄운 일·업무 모니터링 기록은 `~/.secretary/state/<비서 번호>/` 아래에 쓴다(한 PC의 비서 여럿이 같은 파일에 섞어 쓰지 않는다). `~/.secretary/logs/` 바로 아래의 옛 기록은 지우지 않고 그대로 둔다. `~/.claude/usage`의 옛 업무 세션·run-job 기록은 올린 뒤 처음 세션을 열 때 이 비서 몫(번호 없는 옛 기록 포함)을 새 위치로 한 번 복사해 오고, 옛 파일은 그대로 둔다.
- **장기적 관점의 제안:** 나중까지 남는 것을 만들거나 바꾸는 계획에는 지금 안 옆에 장기적 관점의 안을 나란히 적는다.
- **가르쳐 준 업무 지식:** 업무 처리 기준은 공통 스킬 폴더 `../workspaces/_skills/<업무>/`에 쓰고 업무 세션도 같은 원본을 읽는다.
- **기억 중복 확인:** 새 기억이 기존 기억과 거의 같으면(의미 유사도 0.85 이상) 저장 전에 알려 준다.
- **run-job 오래 걸리는 일:** `-Detach`로 띄우고 `scripts/run-job/wait-job.ps1`로 55분마다 깨어 확인한다. 업무 모니터링도 55분마다 깨운다(대화 캐시 1시간 안).
- **세션 재사용 기준 8만 → 20만 토큰:** 업무 세션 재사용과 run-job 자동 재사용(resume)이 마지막 컨텍스트 20만 토큰 미만까지 같은 세션을 다시 쓴다(55분 기준은 그대로). 재사용한 세션이 일을 더 잘하는지 보려고 넓혔다. 판단은 `~/.secretary/state/<비서 번호>/`의 `worker-reuse.jsonl`·`run-job-calls.jsonl`에 쌓이고 `scripts/run-job/run-job-stats.ps1`로 본다.
- **90% 해제에 계정 지정:** 두 번째 구독(선택 기능)을 켰으면 "계정 b 90퍼 넘어도 진행", "계정 a랑 b 모두 90퍼 넘어도 진행"처럼 계정을 적어 그 계정을 푼다. 계정을 적지 않으면 이 대화의 계정만 푼다. 목록에 없는 계정을 말하면 아무것도 풀지 않고 어느 계정인지 묻는다.

고친 것
- 비서 서버를 다시 켜기 직전의 대화가 저장되지 않던 것.
- "90퍼 넘어도 계속"으로 사용량 정지 장치를 풀면 말한 계정뿐 아니라 이 PC의 모든 계정·모든 비서의 정지 장치가 함께 풀리던 것. 이제 그 계정에만 걸린다(계정이 적히지 않은 옛 해제 파일은 읽지 않는다).
- 테스트(`npm test`): 이 PC의 설정 파일(`scripts/*.local.json`)과 기억 DB를 건드리지 않고 임시 폴더에서 돌며, 테스트 뒤 임시 파일이 남거나 모델을 부르면 실패한다.
- 업무 세션·run-job에 붙는 기억 읽기 도구가 기억 DB를 읽기 전용으로 연다(DB가 없으면 만들지 않는다).
- 구독이 아니라 API 키로 로그인한 Claude Code처럼 사용량 조회(`/usage`)가 사용량을 주지 않으면, 사용량 조회기와 정지 훅이 5분마다 조회를 되풀이하던 것. 이제 실패가 이어지면 다음 조회를 최대 6시간까지 미루고, 기록이 없으면 정지 장치는 막지 않는다.
- 다른 세션의 보고나 작업 알림에 "90퍼 넘어도 계속"·"기억 정리 확인" 같은 말이 들어 있으면 사용자가 한 말로 잘못 알아듣던 것.
- 구독이 아닌 계정(API 키, Bedrock, 게이트웨이, 다른 회사 CLI)에 "90퍼 넘어도 계속"이라고 하면 처음부터 막지 않았는데도 "풀었어요"라고 알리던 것. 이제 풀지 않고 "사용량 정지 장치 대상이 아니에요"라고 알린다.
- 설치 상태 점검: 관리자 권한으로 뜬 창의 명령줄을 못 읽거나 예약 작업 조회가 권한으로 막히면 "빠짐"이 아니라 "확인 못 함"으로 둔다(v7과 같음).
- 테스트(`npm test`): 사용자가 직접 만든 PowerShell 스크립트(배포판 파일 목록 `release-files.json`에 없는 파일, 목록이 없으면 기능 목록에 없는 파일)에 BOM이 없거나 구문이 틀려도 실패로 치지 않고 경고만 낸다. 비서가 넣은 스크립트는 그대로 실패로 잡는다.
- 설치 상태 점검: 예약 작업이 등록돼 있어도 가리키는 파일이 없으면(옛 위치의 스크립트를 부르는 v7 작업 등) "등록됐지만 가리키는 파일 없음"과 그 경로를 알린다.
- 한 PC에 비서가 여럿일 때: 예약 작업과 비서 폴더 환경변수는 비서 고유 번호가 붙어 겹치지 않는다. 설치 상태 점검, `scripts/usage/install-usage-guard.mjs`, `scripts/tasks/install-tasks.ps1`은 다른 비서 폴더(번호가 다르거나 번호가 없는 비서 폴더)를 가리키는 사용자 설정의 훅·상태줄과 번호 없는 옛 이름의 예약 작업을 이 비서의 옛 경로로 보지 않고 그대로 둔다. 이 비서 폴더 안의 옛 위치, 같은 번호의 다른 폴더(남겨 둔 옛 사본), 비서가 없어진 폴더(옮기기 전 위치)를 가리킬 때만 고치자고 한다. 다른 비서의 훅·상태줄은 사용량 기록을 PC에서 함께 쓰므로 점검이 통과로 본다.

올린 뒤 할 일 (v7에서)
1. **예약 작업을 번호 붙은 새 이름으로 옮기기:** v8부터 예약 작업 이름 끝에 이 비서의 고유 번호가 붙는다(`Secretary DB Backup` → `Secretary DB Backup (A3F9)`, 번호는 업데이트 끝에 생긴 `.secretary-id`). v7 작업은 옛 이름이고 옮겨진 스크립트를 불러 돌지도 않는다. `node src/cli.ts setup-check`가 이 비서 것(이 비서 폴더나 비서가 없어진 옛 폴더를 부르는 작업)을 "옛 이름 '…'으로 등록됨"으로 알린다. 그 작업만 다시 등록하면 등록 스크립트가 새 이름으로 등록하고 옛 이름 작업을 지운다(옛 작업의 매일 시각·반복 간격·사용 안 함 상태를 이어받는다). 매일 백업: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tasks/install-tasks.ps1 -Task backup`. 비서 서버 자동 시작: **관리자 PowerShell**에서 비서 폴더로 가서 같은 명령에 `-Task server`(옛 서버 작업도 관리자 권한이라야 지워진다. 떠 있는 서버는 그대로 돌고 다음 로그인부터 새 이름 작업이 띄운다). 옛 이름 작업이 이 PC의 다른 비서 것이면 점검이 알리지 않고 스크립트도 건드리지 않는다. 쉬는 시간 작업(새로): `-Task idle-jobs`(관리자 필요 없음, 사용자에게 먼저 묻는다).
2. **사용량 정지 장치:** 등록해 두었으면 `node scripts/usage/install-usage-guard.mjs`를 다시 돌린다(사용자 설정의 훅·상태줄을 `bin/` 진입점으로 고친다. 그대로 두면 훅·상태줄이 없어진 옛 위치의 파일을 불러 정지 장치가 돌지 않는다. 설치 상태 점검이 "옛 경로"로 알린다). 이 PC의 다른 비서 폴더를 가리키는 훅·상태줄은 그 비서 것이라 스크립트가 그대로 두고, 점검도 함께 쓰는 것으로 본다.
3. **비서 폴더 환경변수:** 비서 폴더의 PowerShell에서 `[Environment]::SetEnvironmentVariable("SECRETARY_$((Get-Content .secretary-id).ToUpper())_DIR", (Get-Location).Path, 'User')` 한 번(이 비서 번호가 든 이름, 예: `SECRETARY_A3F9_DIR`. 관리자 필요 없음. 작업 공간 도구는 7번의 `secretary.json`을 먼저 보고, 이 변수 아래 `bin`은 그 파일이 없을 때와 공간 밖 도구가 쓴다). 번호 없는 `SECRETARY_DIR`을 등록해 둔 PC면(v7에는 없던 변수라 보통 없다) 그 이름을 읽는 바깥 도구(작업 공간의 도구·규칙 등)를 사용자와 함께 찾아 새 이름으로 고친 뒤 `[Environment]::SetEnvironmentVariable('SECRETARY_DIR', $null, 'User')`로 지운다(그동안은 둘 다 둔다. 설치 상태 점검이 옛 이름이 남았다고 짧게 적는다).
4. **큰 일 판 옮기기:** v7까지는 큰 일 상태가 프로필의 한 항목이었다. `node src/cli.ts big-work-from-profile <백업 폴더>\big-work-plan.json`으로 옮길 계획을 만들어 보고, 줄마다 상태가 맞는지 확인한 뒤 `--apply`로 판에 넣는다(프로필에서는 그 항목이 빠진 새 버전이 저장된다). 프로필에 큰 일 항목이 없으면 건너뛴다.
5. **v7 때 만든 작업 공간의 규칙:** v7이 만든 공간 `AGENTS.md`에는 근거 저장 도구가 `<비서 폴더>/scripts/ego-grab.mjs`로 적혀 있는데, 그 파일은 `scripts/browser/`로 옮겨졌다(바깥은 `bin/ego-grab.mjs`로 부른다). 비서가 `../workspaces/*/AGENTS.md`에서 그 경로를 찾아 목록을 보여 주고, 승인받아 `<비서 폴더>/bin/ego-grab.mjs`로 고친다(업데이트는 작업 공간을 건드리지 않는다). 공간 안의 grab 스크립트·도구에 같은 경로가 있으면 함께 고친다.
6. 옛 `run-job-home`(비서 폴더 옆)이 아직 있으면 v7 때처럼 `workspaces` 안으로 옮기거나 지운다.
7. **작업 공간의 비서 위치 파일:** 비서 폴더에서 `node src/cli.ts workspace-links --dry-run`으로 고칠 공간을 보여 주고, 승인받아 `node src/cli.ts workspace-links`로 공간마다 맨 위 `secretary.json`(이 비서의 진입점 폴더 `bin`과 번호)을 쓴다(공간의 `.gitignore`에도 한 줄 넣는다). 공간 도구가 비서 진입점을 찾는 파일이다. 공간 안의 도구가 비서 폴더를 직접 적어 두었거나 환경변수로 찾으면, 이 파일을 읽게 고치는 일은 공간마다 업무로 맡긴다(찾는 함수는 새로 만드는 공간 규칙에 들어 있다). 비서 폴더의 `bin` 밖 파일(예: `src/cli.ts`)을 부르는 공간 도구는 업무 세션에서 막히므로 함께 고친다.
8. **스킬 위치 확인:** v7의 `.claude/skills/<이름>`(실제 폴더)은 v8에서 `.agents/skills/<이름>`으로 옮겨지고 `.claude/skills`는 그리로 가는 링크 하나가 된다. 업데이트(apply)가 옮기기와 링크 만들기를 한 번에 한다: 사용자가 고친 스킬은 고친 내용 그대로, 사용자가 `.claude/skills/`에 만든 스킬도 `.agents/skills/`로 옮긴다. `node src/cli.ts setup-check`의 '스킬'(skills) 항목이 통과인지 본다. 빠졌으면 `node src/cli.ts skill-links --dry-run`으로 보여 주고 `node src/cli.ts skill-links`로 만든다. 링크 위치에 실제 폴더가 남아 있으면(명령이 지우지 않는다) `.agents/skills/<이름>`과 비교해 사용자에게 보여 주고, 고친 내용을 옮긴 뒤 그 폴더를 지울지 묻는다. apply 출력에 "같은 자리에 내용이 다른 파일이 있어 옮기지 않고 따로 둠"이 있었으면 그 파일(`<백업 폴더>\skills-kept\…`)도 함께 보여 주고 어떻게 할지 묻는다.
9. 비서 서버를 쓰고 있으면 다시 켠다(`scripts/server/server-control.ps1 -Action restart`).

## v7

- 업데이트 기능("업데이트 확인해 줘", `VERSION` 파일). v8의 업데이트는 v7부터 올린다.
- 설치 상태 점검: 세션을 열 때 빠진 설치 항목이 있으면 비서가 매 답 맨 위에 알린다. 다 됐으면 토큰이 들지 않는다.
- 직전 답까지 보고 기억 찾기("1번으로"처럼 짧은 답도), 의미 검색 기준값 0.18 → 0.20.
- 답 방식: 언제나 한국어, 끝난 일 보고 때 휴대폰 알림, 지금 상태는 그 자리에서 확인, 경로는 코드 블록, 모르는 별칭은 한 번 묻기.
- 컨텍스트 크기 알림(15만 토큰부터 5만마다 `/clear` 권유), 상황판의 "(끝난 듯, #번호)", 남은 질문 닫기, 업무 모니터링이 busy인 채 멈춘 세션도 알림, 사용량 정지 장치의 주간 사용량.
- run-job 기본 폴더 `run-job-home` → `workspaces\run-job-home`.

## v6

- 의미 검색 도우미가 모델 파일이 없거나 깨지면 한 번 다시 받아 띄우고, 메모리가 부족하면 멈추고 묻는다.
- "90퍼 넘어도 계속"처럼 비슷한 말도 정지 장치를 푼다. 질문은 보고 글 속에 섞지 않는다. `/consolidate` 뒤 핵심 프로필 전체를 번호 붙여 보여 준다.

## v5

- 새 작업 공간이 비서 폴더 옆 `workspaces` 폴더 안에 생긴다(옛 공간은 그 안으로 옮기면 그대로 찾는다).
- `/consolidate`가 긴 메시지를 다 읽고 정리 대기가 0이 될 때까지 잇는다. 상황판 Haiku 추론 수준(effort) medium. 의미 검색 도우미 장애 복구와 기록.

## v4 이하

- v4: 비서 서버가 창 없이, 가장 높은 권한으로 자동 시작(관리자 PowerShell에서 등록), UAC 안내.
- v3: 상황판(새 세션이 이어받기).
- v2: 한국어 미세조정 검색 모델 BGE-m3-ko(v1의 bge-m3에서 바뀌어 처음 켤 때 기억 전체를 한 번 다시 색인).
- v1: 첫 배포판.
- 버전마다의 자세한 내용은 공개 저장소에서 그 tag의 README "갈아타기" 절에 있다.
