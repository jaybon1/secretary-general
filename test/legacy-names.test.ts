import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { dueLegacyNames, LEGACY_KINDS, LEGACY_NAMES, removeWhen, todayKst, type LegacyName } from '../src/core/legacy-names.ts';
import { readFeatures } from '../src/core/features.ts';

const MARK = /legacy-name: ([a-z0-9-]+)/g;

/** The marks in the files under src, scripts and bin: id → the files that carry it. */
function marks(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      : [];
  for (const file of ['src', 'scripts', 'bin'].flatMap((d) => walk(path.join(PROJECT_ROOT, d)))) {
    if (!/\.(ts|mjs|js|ps1|py)$/.test(file)) continue;
    const rel = path.relative(PROJECT_ROOT, file).replaceAll('\\', '/');
    for (const m of fs.readFileSync(file, 'utf8').matchAll(MARK)) found.set(m[1], [...(found.get(m[1]) ?? []), rel]);
  }
  return found;
}

// 없으면 놓치는 실수: 옛 이름을 함께 읽는 코드가 표 없이 흩어져, 언제 지울지 모르고 영영 남거나 표에만 있고 코드에서는 이미 빠진 줄이 남는다.
test('legacy names: every mark in the code has a row, every row has a mark (where its feature is), each row well formed', () => {
  const ids = LEGACY_NAMES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids once each');
  const features = new Set((readFeatures(PROJECT_ROOT) ?? []).map((f) => f.id));
  for (const r of LEGACY_NAMES) {
    assert.match(r.checkBy, /^\d{4}-\d{2}-\d{2}$/, r.id);
    assert.equal(new Date(`${r.checkBy}T00:00:00Z`).toISOString().slice(0, 10), r.checkBy, `${r.id}: a real day`);
    for (const k of ['old', 'now'] as const) assert.ok(r[k].trim(), `${r.id}.${k}`);
    // 없으면 놓치는 실수: 종류 없이 조건 글만 있어, 이 PC에서만 지우면 되는 줄과 배포판 다음 버전까지 둬야 하는 줄을 가르지 못한다.
    assert.ok(r.kind in LEGACY_KINDS, `${r.id}.kind`);
    assert.ok(r.alsoWhen === undefined || r.alsoWhen.trim(), `${r.id}.alsoWhen`);
    assert.ok(features.has(r.feature), `${r.id}: feature ${r.feature} is in features.json`);
  }
  const found = marks();
  for (const [id, files] of found) assert.ok(ids.includes(id), `legacy-name: ${id} (${files.join(', ')}) has no row in src/core/legacy-names.ts`);
  for (const r of LEGACY_NAMES) assert.ok(found.has(r.id), `${r.id}: no "legacy-name: ${r.id}" mark in the code (the reading is gone: take the row out)`);
});

// 없으면 놓치는 실수: 지울 날이 지난 옛 이름 읽기를 아무도 다시 보지 않는다(테스트를 실패시키지는 않고 알리기만 한다).
test('legacy names: rows whose day has come are said (a notice, not a failure)', (t) => {
  const rows: LegacyName[] = [
    { id: 'a', old: 'o', now: 'n', kind: 'pc-only', alsoWhen: 'w', checkBy: '2026-12-10', feature: 'f' },
    { id: 'b', old: 'o', now: 'n', kind: 'release-move', checkBy: '2027-02-10', feature: 'f' },
  ];
  assert.deepEqual(dueLegacyNames('2026-12-09', rows), []);
  assert.deepEqual(dueLegacyNames('2026-12-10', rows).map((r) => r.id), ['a']);
  assert.deepEqual(dueLegacyNames('2027-03-01', rows).map((r) => r.id), ['a', 'b']);
  assert.match(todayKst(Date.parse('2026-12-09T15:00:00Z')), /^2026-12-10$/, 'the day in KST');
  assert.match(removeWhen(rows[0]), /^\[이 PC 전용\] .+ — w$/);
  assert.match(removeWhen(rows[1]), /^\[배포판 옮기기\] [^—]+$/);
  for (const r of dueLegacyNames()) {
    t.diagnostic(`옛 이름 읽기 다시 볼 날 지남(${r.checkBy}): ${r.id} — ${r.old} → ${r.now}. 지울 조건: ${removeWhen(r)} (src/core/legacy-names.ts)`);
  }
});
