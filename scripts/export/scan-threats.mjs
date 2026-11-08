// export-workspace.ps1이 부른다. 폴더 안 글 파일을 줄마다 src/memory/injection-screen.ts의 주입·유출 패턴으로, 파일 전체를 src/core/secrets.ts의
// 키 패턴(기억 저장 때 가리는 것과 같은 목록)으로 검사해 "상대경로<TAB>줄 번호<TAB>패턴 id"를 한 줄씩 낸다
// (키는 id가 secret이고, 뒤에 그 줄에서 값의 시작 위치<TAB>길이를 붙인다).
// 걸린 게 없으면 아무것도 내지 않는다. 바이너리 파일은 건너뛴다.
//
// 예: node --no-warnings scripts/export/scan-threats.mjs <폴더>
import fs from 'node:fs';
import path from 'node:path';
import { secretSpans } from '../../src/core/secrets.ts';
import { findThreat } from '../../src/memory/injection-screen.ts';

const root = path.resolve(process.argv[2] ?? '.');
for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const rel = path.relative(root, file).replaceAll('\\', '/');
  // 파일 맨 앞 BOM(U+FEFF)은 인코딩 표시라 뺀다. 남기면 1행이 보이지 않는 글자(invisible_unicode)로 걸린다.
  // 본문 중간의 U+FEFF·보이지 않는 글자는 그대로 두어 계속 잡는다. 키 위치도 BOM을 뺀 글 기준(export-workspace.ps1이 BOM 없이 읽은 줄과 맞춘다).
  const text = buf.toString('utf8').replace(/^﻿/, '');
  text.split(/\r?\n/).forEach((line, i) => {
    const id = findThreat(line);
    if (id) console.log(`${rel}\t${i + 1}\t${id}`);
  });
  for (const s of secretSpans(text)) console.log(`${rel}\t${s.line}\tsecret\t${s.start}\t${s.length}`);
}
