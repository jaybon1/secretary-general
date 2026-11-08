---
name: chrome-fallback
description: Ego Lite(ego-browser)가 없거나 안 될 때 Claude in Chrome으로 브라우저 작업을 대신하는 절차. Ego Lite가 실패하거나 쓸 수 없을 때, 또는 Claude in Chrome을 쓰라고 할 때 사용.
---

# Claude in Chrome (Ego Lite 대체)

Ego Lite가 없거나 안 될 때만 Claude in Chrome 확장을 쓴다(네이버는 막힌다). 이 PC 크롬에서 브라우저 작업용으로 정한 프로필(사용자가 알려 준 이름, 기억에 있다. 없으면 묻는다)을 쓴다.

1. `list_connected_browsers`로 연결을 본다. 이 PC 브라우저가 있으면 바로 탐색한다.
2. 없으면 `scripts/browser/open-chrome.ps1 -ProfileName <프로필 이름>`으로 그 프로필 창을 열고, 몇 초 기다렸다가 다시 확인한 뒤 탐색한다. 그래도 없으면 확장 상태를 확인해 달라고 말한다.
3. 다른 PC 브라우저까지 둘 이상 잡히면 고르기 전에 묻는다.

- 탭은 새로 열어 쓰고, 끝나면 닫는다.
