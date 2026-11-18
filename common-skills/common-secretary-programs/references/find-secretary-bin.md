# 비서 진입점 폴더(bin) 찾는 함수

도구에 아래 함수 하나를 그대로 넣는다. 도구 파일이 있는 폴더에서 위로 올라가며 `secretary-link.local.json`(작업 공간 맨 위에 비서가 써 둔다)를 찾아 그 `bin`을 돌려준다. 없으면 이 PC의 비서 폴더 환경변수 `SECRETARY_<번호>_DIR` 가운데 비서 폴더(`.secretary-id`가 있는 폴더)를 가리키는 것이 하나뿐일 때 그 아래 `bin`을 돌려준다. 둘 이상이거나 없으면 Python은 까닭을 적고 멈추고, PowerShell·Node는 빈 값을 돌려준다.

이유: 비서 번호(변수 이름)는 비서마다 달라 도구에 박아 둘 수 없다. 공간 밖 도구(공통 스킬의 `scripts/` 등)는 위치 파일이 없어 변수로 찾는다. 같은 PC에 비서가 여럿이면 어느 비서인지 짐작하지 않는다(그때는 위치 파일이 있는 곳에서 부른다).

## Python

```python
import json, os, re
from pathlib import Path
def secretary_bin(start=Path(__file__).resolve()):
    for d in start.parents:
        f = d / "secretary-link.local.json"
        if f.is_file(): return Path(json.loads(f.read_text(encoding="utf-8-sig"))["bin"])
    found = sorted(k for k, v in os.environ.items() if re.fullmatch(r"SECRETARY_[A-Z0-9]+_DIR", k, re.I) and v and (Path(v) / ".secretary-id").is_file())
    if len(found) != 1: raise SystemExit(f"비서 진입점을 못 찾음: 위 폴더들에 비서 위치 파일이 없고 비서 폴더 환경변수(SECRETARY_<번호>_DIR)가 하나가 아니다({', '.join(found) or '없음'}). 비서에게 workspace-links를 부탁한다")
    return Path(os.environ[found[0]]) / "bin"
```

## PowerShell

```powershell
function Get-SecretaryBin([string]$Dir = $PSScriptRoot) {
  for ($d = $Dir; $d; $d = Split-Path $d) { $f = Join-Path $d 'secretary-link.local.json'; if (Test-Path -LiteralPath $f) { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).bin } }
  $found = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^SECRETARY_[A-Z0-9]+_DIR$' -and $_.Value -and (Test-Path -LiteralPath (Join-Path $_.Value '.secretary-id')) })
  if ($found.Count -eq 1) { Join-Path $found[0].Value 'bin' }
}
```

## Node

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function secretaryBin(dir = path.dirname(fileURLToPath(import.meta.url))) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, 'secretary-link.local.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')).bin;
    if (path.dirname(d) === d) break;
  }
  const found = Object.keys(process.env).filter((k) => /^SECRETARY_[A-Z0-9]+_DIR$/i.test(k) && process.env[k] && fs.existsSync(path.join(process.env[k], '.secretary-id')));
  return found.length === 1 ? path.join(process.env[found[0]], 'bin') : undefined;
}
```
