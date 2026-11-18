import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, DIRECTION_ALLOWED as ALLOWED, directionBreaks, fileCycles, folderCycles, folderOf, LAYERS, layerOf } from './import-graph.ts';

const g = buildGraph();

// 없으면 놓치는 실수: 두 파일이 서로 import해, 어느 쪽을 먼저 불러오느냐에 따라 아직 만들어지지 않은 값을 읽고 죽는다.
test('no two files import each other, directly or around a loop (runtime imports)', () => {
  assert.deepEqual(fileCycles(g), []);
});

// 없으면 놓치는 실수: 폴더끼리 서로 기대게 되어 공용 코드가 기능 폴더에 숨고, test:changed의 범위와 구조가 다시 꼬인다.
test('the src folders keep their direction: no folder imports a higher layer, and no folder loop', () => {
  assert.deepEqual(folderCycles(g), []);
  assert.deepEqual(directionBreaks(g, ALLOWED), [], `test/import-graph.ts LAYERS의 방향(아래 층만 import)과 맞지 않음`);
  const srcFolders = [...new Set(Object.keys(g).map(folderOf))].filter((f) => f.startsWith('src/'));
  assert.deepEqual(srcFolders.filter((f) => layerOf(f) === undefined), [], 'a new src folder needs a layer in LAYERS');
  // A kept exception that is gone (moved, fixed) is taken off the list; one whose files are not in this copy (a feature
  // the release leaves out) is passed over.
  for (const a of ALLOWED) {
    const [from, to] = a.split(' -> ');
    if (g[from] && g[to]) assert.ok(g[from].some((e) => e.to === to), `ALLOWED에 남은 옛 줄: ${a}`);
  }
  assert.equal(new Set(LAYERS.flatMap((l) => l.folders)).size, LAYERS.flatMap((l) => l.folders).length, 'a folder on two layers');
});
