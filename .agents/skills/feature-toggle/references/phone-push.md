# 끝 알림 (`phone-push`)

비서 세션의 턴이 끝날 때마다 끝(Stop) 훅이 모델을 부르지 않고 답의 첫 줄(결론 줄)을 이 PC에 띄운 ntfy 서버로 보내고, 폰의 ntfy 앱이 그 알림을 띄운다. 답이 다 써진 뒤에 오고, 알림 때문에 모델 요청이 더 들지 않는다.

- 보내지 않는 때: 답변 검사(`mistake-guards`)가 턴을 되돌린 때(다시 쓴 답이 끝날 때 보낸다), 서브에이전트, 업무 세션·run-job(다른 폴더에서 돌아 이 훅을 안 쓴다), 시험 실행, `this-secretary.local.json`의 `phone-push` 칸이 없을 때.
- 보내기는 따로 떨어진 프로세스가 해서 훅이 기다리지 않는다. 서버가 꺼져 있거나 시간 초과(기본 2.5초)면 조용히 넘기고 `~/.secretary/<비서 고유 번호>/logs/notify.log`에 한 줄 남긴다.
- 제목은 세션 이름(없으면 "비서"), 본문은 답 첫 줄(마크다운 기호를 걷고 200자 안팎으로 자름, 맨 앞의 `>` 인용 머리줄은 건너뜀).
- 알림을 누르면 그 세션의 Claude 대화(Remote Control이면 `https://claude.ai/code/session_…`, 모르면 `https://claude.ai/code`)가 열린다.

## 켜기 전에 사용자와 정할 것

1. ntfy 서버를 이 PC에 둘지(Windows용 ntfy 서버, https://docs.ntfy.sh/install/ ), 다른 곳의 서버를 쓸지. 이 PC에 두면 로그인 때 예약 작업으로 띄운다(관리자 불필요).
2. 폰에서 서버에 닿는 길: Tailscale 같은 사설망(권장, 인터넷에 열지 않는다)인지. HTTPS 주소는 Tailscale Serve가 낸다.
3. 토픽 이름, 알림 우선순위(기본 4: 팝업과 소리, 3은 소리만), 접근 토큰을 둘지.
4. PC 브라우저에서도 받을지(웹 푸시: ntfy 웹 화면에서 토픽을 구독하면 탭을 닫아도 알림이 온다). 받으려면 푸시 서비스에 알릴 관리자 메일 주소 하나가 필요하다(사용자가 정한 주소를 쓴다).

## 켜는 순서

1. ntfy 서버(`ntfy.exe`)를 받아 `%USERPROFILE%\.secretary\ntfy\`에 둔다(받는 명령을 보여 주고 사용자 승인 뒤). 이어서 `scripts/phone-push/install-ntfy.ps1 -DryRun`으로 할 일을 보여 주고, 승인 뒤 `-DryRun` 없이 돌린다: 같은 폴더에 `server.yml`(`listen-http`는 `127.0.0.1:2586`, `-BaseUrl`로 폰이 여는 주소)을 만들고, 로그인 때 창 없이 `ntfy serve`를 띄우는 예약 작업 `Secretary ntfy Server (고유 번호)`를 등록한다. 지금 바로 띄우려면 `Start-ScheduledTask -TaskName '<그 이름>'`.
   - 웹 푸시(4번에서 정한 경우): `-WebPush -WebPushEmail <관리자 메일>`을 더한다(`-BaseUrl`도 있어야 한다). 새로 만드는 `server.yml`에 `ntfy webpush keys`로 만든 키 두 줄과 `web-push-file`(설정 옆 `webpush.db`), `web-push-email-address`가 들어간다. 개인 키는 그 파일에만 쓰이고 화면에 찍히지 않는다. 대화에 옮겨 적지 않는다.
   - `server.yml`이 이미 있으면 스크립트는 고치지 않는다. `-WebPush`로 돌리면 웹 푸시 줄이 없을 때 넣는 법(사용자가 PowerShell에서 직접 `ntfy webpush keys`를 돌려 두 줄을 붙이고, `web-push-file`·`web-push-email-address`를 더한 뒤 ntfy 작업을 다시 띄우기)을 찍으니 그대로 안내한다.
2. 폰에서 열려면(정한 경우) 사용자 승인 뒤 `tailscale serve --bg --https=<다른 포트> http://127.0.0.1:<포트>`(이미 443을 쓰는 Serve가 있으면 다른 포트로).
3. 이 비서 설정 파일 `this-secretary.local.json`(비서 폴더 맨 위, 커밋하지 않음, 예시 `this-secretary.local.example.json`)에 `phone-push` 칸을 쓴다(칸 안의 값은 `src/phone-push/ntfy.ts` 첫 주석). 예: `"phone-push": { "url": "http://127.0.0.1:2586", "topic": "secretary" }`(우선순위 4, 누르면 대화가 열림이 기본).
4. 폰 ntfy 앱에서 자체 서버 주소와 토픽을 구독하게 하고(안드로이드는 "instant delivery"를 켠다), 다음 답이 끝날 때 알림이 오는지 사용자에게 봐 달라고 한다. 웹 푸시를 켰으면 PC 브라우저로 폰과 같은 주소를 열어 토픽을 구독하고 알림을 허락하게 한다.
5. `features.json`의 `phone-push`를 `"enabled": true`로, AGENTS.md `### 기본` 절의 "답의 첫 줄은 언제나"로 시작하는 `PushNotification` 줄을 아래 글로 바꾼다.

## AGENTS.md에 넣을 글

```
- 답의 첫 줄은 언제나 그것만 읽어도 알 수 있는 결론으로 쓴다. 턴이 끝나면 Stop 훅이 첫 줄을 폰(ntfy)으로 자동으로 보내기 때문이다. 비서는 `PushNotification`을 부르지 않는다(스킬에 보내라고 적힌 곳도 같다).
```

## 끄는 순서

1. `"enabled": false`, AGENTS.md의 위 글을 원래의 `PushNotification` 줄로 되돌린다(바로 멈추려면 `this-secretary.local.json`의 `phone-push` 칸에 `"enabled": false`).
2. ntfy 서버 작업과 Tailscale Serve는 사용자 승인 뒤 끈다(`Stop-ScheduledTask`·`Unregister-ScheduledTask -TaskName '<Secretary ntfy Server (고유 번호)>' -Confirm:$false`, `tailscale serve --https=<포트> off`).
3. `this-secretary.local.json`의 `phone-push` 칸은 지우지 않는다(기능이 꺼져 있으면 읽지 않는다). 지우려면 따로 묻는다.
