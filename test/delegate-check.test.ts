import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, testStore, write } from './helpers.ts';
import { briefCoverage, decisionBody, decisionsFor, main, privateWords, privateHits, profileTitles } from '../scripts/delegate-check/delegate-check.ts';

test('brief: the decisions of the given tags (and a query), the ones the brief leaves out first', () => {
  const file = path.join(tempDir(), 'd.db');
  const store = testStore(file);
  const tts = store.remember({ kind: 'decision', content: '2026-11-01 사용자 결정(더빙): 더빙 목소리는 Speechify-K2로 만들고 속도는 1.1배로 한다.', tags: ['영상', '더빙'] }).id;
  const sub = store.remember({ kind: 'decision', content: '자막은 화면 아래 두 줄까지만 쓴다.', tags: ['영상', '자막'] }).id;
  store.remember({ kind: 'fact', content: '더빙 업무는 영상 공간에서 한다.', tags: ['영상', '더빙'] });
  const old = store.remember({ kind: 'decision', content: '더빙은 옛 방식으로 한다.', tags: ['영상', '더빙'] }).id;
  store.forget(old, 'x');
  store.remember({ kind: 'decision', content: '블로그는 주 2회 올린다.', tags: ['블로그'] });
  const ds = decisionsFor(store.db, ['더빙']);
  assert.deepEqual(ds.map((d) => d.id), [tts], 'decisions only, active only, by tag');
  assert.deepEqual(decisionsFor(store.db, ['영상']).map((d) => d.id), [tts, sub]);
  assert.deepEqual(decisionsFor(store.db, [], '자막 줄').map((d) => d.id), [sub], 'a query finds one without the tag');
  // 없으면 놓치는 실수: 사용자가 하라고 한 할 일(action 기억)이 지시서에서 빠져도 대조에 안 걸린다. 두 낱말 태그("모종 가게")는 한 태그로든,
  // 옛 태그를 띄어쓰기로 나눈 두 태그로든 찾는다(태그 표, 옮기기 21).
  const todo = store.remember({ kind: 'action', content: '더빙 파일 이름에 날짜를 붙인다.', tags: ['영상', '모종 가게'] }).id;
  const split = store.remember({ kind: 'decision', content: '더빙은 두 번 듣고 넘긴다.', tags: ['영상', '모종', '가게'] }).id;
  assert.deepEqual(decisionsFor(store.db, ['모종 가게']).map((d) => [d.id, d.kind]), [[todo, 'action'], [split, 'decision']]);
  store.forget(todo, 'x');
  store.forget(split, 'x');
  assert.equal(decisionBody('2026-11-01 사용자 결정(더빙): 더빙 목소리'), '더빙 목소리');
  // A brief that leaves the voice out: shown first, with the name it lacks.
  const left = briefCoverage('# 더빙\n안내 영상의 더빙을 만든다. 자막은 화면 아래 두 줄까지만.', decisionsFor(store.db, ['영상']));
  assert.equal(left[0].decision.id, tts);
  assert.ok(left[0].covered < 0.5, String(left[0].covered));
  assert.deepEqual(left[0].missingNames, ['Speechify-K2']);
  assert.ok(left[1].covered >= 0.5);
  // One that carries it.
  const full = briefCoverage('더빙 목소리는 Speechify-K2로 만들고 속도는 1.1배로 한다.', ds);
  assert.ok(full[0].covered >= 0.8 && full[0].missingNames.length === 0);
  store.db.close();
  // The command line: exit 1 while something is left out, the DB only read.
  const brief = path.join(tempDir(), 'TASK.md');
  write(brief, '# 더빙\n더빙 목소리를 만든다.');
  const out: string[] = [];
  assert.equal(main(['brief', brief, '--tag', '더빙', '--db', file], (s) => out.push(s)), 1);
  assert.match(out.join('\n'), /지시서에 안 들어간 듯 1개[^]*\[빠진 듯 \d+% · 관련 [\d.]+\] #1 [^]*겹친 말: [^]*지시서에 없는 이름·숫자: Speechify-K2/);
  assert.equal(main(['brief', brief, '--db', file], () => {}), 2, 'no tag, no query');
  assert.equal(main(['brief', brief, '--tag', 'x', '--db', path.join(tempDir(), 'none.db')], () => {}), 2);
});

// [늘 남김] 없으면 놓치는 실수: 개인정보를 넣으면 안 되는 공급자(게이트웨이·무료 플랜)로 보내는 지시나 그 TASK.md에 사용자 호칭, 기억·대화 번호,
// 다른 작업 공간 이야기가 그대로 들어가 그 회사 서버로 나가거나, 개인정보를 넣어도 되는 공급자의 지시까지 막는다.
test('private: a brief for a provider personal data may not go to is stopped on the title, record numbers and other workspaces', () => {
  const file = path.join(tempDir(), 'p.db');
  const store = testStore(file);
  store.setUserTitle('홍길동');
  store.updateProfile('# 핵심 프로필\n- 호칭: **길동** / **길동님**.\n- 개발자다.', 'test');
  const ws = tempDir();
  const own = path.join(ws, 'blog-20260101');
  for (const [kind, name, title, folder] of [
    ['solo', 'blog', '여행 블로그', own],
    ['solo', 'cafe-shop', '동네 카페 쇼핑몰', path.join(ws, 'cafe-shop-20260102')],
    ['quick', 'quick-outputs', '간단한 결과물 모음', path.join(ws, 'quick-outputs')],
  ] as const) store.createWorkspace({ kind, name, title, purpose: 'p', folder, agents: [] });
  store.db.close();
  assert.deepEqual(profileTitles('- 호칭: **길동** / **길동님**.\n- 부르는 법: 사용자'), ['길동']);
  const db = testStore(file).db;
  const words = privateWords(db, own);
  assert.deepEqual([...words.titles].sort(), ['길동', '홍길동']);
  // The workspace the work goes to and the shared quick one are not "other".
  assert.deepEqual(words.workspaces.map((w) => w.label), ['동네 카페 쇼핑몰']);
  // Not numbers of records: a colour on a colour line, a URL fragment, an HTML entity (the # joined in, so the records check does not read them as citations).
  const h = '#';
  const hits = privateHits(
    ['홍길동님이 고른 색으로 만든다.', '근거 대화 #900123, 기억 #900124.', '동네 카페 쇼핑몰 공간과 같은 톤.', `배경은 ${h}333333, 링크는 page${h}2, 개체는 &${h}123;.`, 'website와 blog 글.'].join('\n'),
    'TASK.md',
    words,
  );
  assert.deepEqual(hits.map((h) => `${h.line}:${h.kind}:${h.what}`), ['1:호칭:홍길동', '1:호칭:길동', '2:기억·대화 번호:#900123', '2:기억·대화 번호:#900124', '3:다른 작업 공간:동네 카페 쇼핑몰(동네 카페 쇼핑몰)']);
  db.close();
  // The command line: the prompt and the TASK.md it names (relative to the workspace), exit 1 on a hit, 0 when clean,
  // nothing checked for a provider personal data may go to, 2 without the DB.
  const providers = path.join(tempDir(), 'providers.json');
  write(providers, JSON.stringify({ providers: { sub: { type: 'claude-subscription', personalDataAllowed: true }, gw: { type: 'claude-gateway', personalDataAllowed: false } } }));
  write(path.join(own, 'output', 'records', 'x', 'TASK.md'), '# 업무\n## 사용자 원문\n"만들어 줘" (#900125)\n');
  const prompt = path.join(tempDir(), 'prompt.md');
  write(prompt, 'output/records/x/TASK.md의 업무를 이 폴더의 AGENTS.md 규칙대로 수행하라.');
  const run = (provider: string, db = file) => {
    const out: string[] = [];
    const code = main(['private', prompt, '--provider', provider, '--folder', own, '--db', db, '--providers', providers], (s) => out.push(s));
    return { code, out: out.join('\n') };
  };
  const gw = run('gw');
  assert.equal(gw.code, 1, gw.out);
  assert.match(gw.out, /TASK\.md:3 \[기억·대화 번호\] #900125/);
  assert.equal(run('unknown-provider').code, 1, 'a provider not in the file counts as one personal data may not go to');
  assert.match(run('sub').out, /검사 안 함/);
  assert.equal(run('sub').code, 0);
  assert.equal(run('gw', path.join(tempDir(), 'none.db')).code, 2);
  write(path.join(own, 'output', 'records', 'x', 'TASK.md'), '# 업무\n## 사용자 원문\n"만들어 줘"\n');
  assert.equal(run('gw').code, 0);
});
