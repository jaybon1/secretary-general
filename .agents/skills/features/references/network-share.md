# 네트워크 공유 (`network-share`) (실행 확인 안 됨)

비서가 도는 PC의 비서 상위 폴더(비서 폴더와 `workspaces`, `notes`, `inbox`가 든 폴더)를 같은 집·사무실의 다른 PC에서 파일 탐색기로 보게 한다. 상위 폴더는 **읽기 전용**으로 공유하고, 쓰기는 `notes`(메모 볼트)와 `inbox`(받은 파일)만 따로 공유해 연다. Windows 파일 공유(SMB)를 쓴다. 비서 코드는 바뀌지 않는다(PC 설정만 바뀐다).

- 다른 PC에서 비서 폴더를 열어 비서를 돌리지는 않는다. 공유는 읽기 전용이라 기억·대화 저장이 막히고, 네트워크 너머로 SQLite를 쓰면 파일이 깨질 수 있다. 다른 PC에서 비서를 쓰려면 Remote Control(README "다른 기기에서 쓰기")을 쓴다.
- 이 배포판에서 아래 명령을 실제로 돌려 확인하지는 않았다(공유 구성은 원래 비서를 만든 PC에서 손으로 한 것과 같은 꼴). 단계마다 출력을 보고 진행한다.

## 켜기 전에 사용자와 정할 것

1. 같은 네트워크(공유기)인지, 서로 다른 네트워크라면 Tailscale 같은 사설망을 쓸지. 방화벽은 **개인(Private) 네트워크에서만** 연다.
2. 이 PC의 Windows 계정에 비밀번호가 없으면 네트워크로 접속할 수 없다. 공유 전용 일반 계정(예: `secretary-share`)을 하나 만들어 그 계정에만 공유 권한을 준다(자동 로그인에 영향 없음). 비밀번호는 사용자가 정하고 대화에 쓰지 않는다.
3. `notes`·`inbox`도 켤지(없으면 상위 폴더 읽기 전용 공유만).

## 켜는 순서 (관리자 PowerShell, 사용자가 실행)

명령을 사용자에게 보여 주고, 관리자 PowerShell(시작 단추 오른쪽 클릭 → 터미널(관리자))에서 실행해 달라고 부탁한다. `<상위 폴더>`는 비서 폴더의 부모 폴더 전체 경로다.

1. 공유 전용 계정(정했으면): `$pw = Read-Host -AsSecureString '비밀번호'; New-LocalUser -Name secretary-share -Password $pw -PasswordNeverExpires -UserMayNotChangePassword`
2. 상위 폴더 읽기 전용 공유: `New-SmbShare -Name ai-agent -Path '<상위 폴더>' -ReadAccess secretary-share`
3. 쓰기 공유(켠 것만): `New-SmbShare -Name notes -Path '<상위 폴더>\notes' -ChangeAccess secretary-share`, `New-SmbShare -Name inbox -Path '<상위 폴더>\inbox' -ChangeAccess secretary-share`
4. 폴더 권한(NTFS): `icacls '<상위 폴더>' /grant 'secretary-share:(OI)(CI)RX'`, 쓰기 공유 폴더마다 `icacls '<상위 폴더>\inbox' /grant 'secretary-share:(OI)(CI)M'`
5. 방화벽(개인 네트워크만): `Get-NetFirewallRule -DisplayGroup '파일 및 프린터 공유' | Where-Object { $_.Profile -match 'Private' } | Enable-NetFirewallRule` (영문 Windows는 `'File and Printer Sharing'`)
6. 다른 PC에서 확인(사용자): 탐색기 주소창에 `\\<이 PC 이름 또는 주소>\ai-agent` → 공유 계정으로 로그인 → 읽기만 되는지, `\\<주소>\inbox`에 파일을 넣을 수 있는지. `ai-agent` 안의 `inbox`로 들어가면 상위 공유를 따라 쓰기가 막히므로 쓰기는 `\\<주소>\inbox` 주소로 바로 들어간다.
7. 확인되면 `features.json`의 `network-share`를 `"enabled": true`로, 아래 글을 AGENTS.md의 `## 메모와 받은 파일` 절 제목 바로 아래에 넣는다(절이 없으면 `## 브라우저 작업` 앞에 제목과 함께 만든다).

## AGENTS.md에 넣을 글

```
비서 상위 폴더는 다른 PC에서 네트워크 공유로 본다(읽기 전용). 쓰기는 `notes`·`inbox` 공유로만 되고, 다른 PC에서 넘긴 파일은 `../inbox`에 온다.
```

## 끄는 순서

관리자 PowerShell에서 `Remove-SmbShare -Name ai-agent -Force`(켠 것마다 `notes`, `inbox`도). 공유 계정은 사용자에게 지울지 묻고(`Remove-LocalUser -Name secretary-share`), 방화벽 규칙은 다른 프로그램이 쓸 수 있으니 그대로 둘지 묻는다. `"enabled": false`, AGENTS.md에서 위 글을 뺀다.
