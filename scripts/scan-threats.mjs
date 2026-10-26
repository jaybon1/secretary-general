// export-workspace.ps1이 부른다. 폴더 안 글 파일을 줄마다 src/threats.ts의 주입·유출 패턴으로 검사해
// "상대경로<TAB>줄 번호<TAB>패턴 id"를 한 줄씩 낸다. 걸린 게 없으면 아무것도 내지 않는다. 바이너리 파일은 건너뛴다.
//
// 예: node --no-warnings scripts/scan-threats.mjs <폴더>
import fs from 'node:fs';
import path from 'node:path';
import { findThreat } from '../src/threats.ts';

const root = path.resolve(process.argv[2] ?? '.');
for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const rel = path.relative(root, file).replaceAll('\\', '/');
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    const id = findThreat(line);
    if (id) console.log(`${rel}\t${i + 1}\t${id}`);
  });
}
