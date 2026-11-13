import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/core/config.ts';
import type { Store } from '../src/store/store.ts';
import { guardsOn } from '../src/mistake-guards/mistake-guard-settings.ts';
import { MISTAKE_TOOLS } from '../src/mcp/mistake-tools.ts';
import { tempDir, testStore } from './helpers.ts';
import { runConsolidate } from '../src/memory/consolidate-run.ts';

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

// [늘 남김] 없으면 놓치는 실수: 실제 MCP 서버에서 기억 저장 → 찾기 → 바꾸기가 끊겨, 비서가 기억을 남기거나 꺼내지 못한다(기억 핵심 경로).
test('MCP server: remember → recall → supersede → stats over stdio', async () => {
  const workspaces = tempDir();
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts')],
      env: {
        ...(process.env as Record<string, string>),
        SECRETARY_DB: path.join(tempDir(), 'mcp.db'),
        SECRETARY_WORKSPACE_ROOT: workspaces,
      },
    }),
  );
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    // The mistake record's tools come with feature 'mistake-guards' (off in a copy that turned it off).
    assert.deepEqual(tools, [
      'create_task', 'create_workspace', 'forget', 'get_profile', 'get_task', 'get_unconsolidated_log', 'list_main_agenda',
      'list_memories', 'list_tasks', 'list_topics', 'list_workspaces', 'mark_consolidated', 'recall', 'remember', 'search_log', 'set_main_agenda',
      'stats', 'update_profile', 'update_task', ...(guardsOn() ? MISTAKE_TOOLS : []),
    ].sort());

    const r1 = text(await client.callTool({ name: 'remember', arguments: { kind: 'preference', content: '회의는 오전 10시 이후를 선호한다.' } }));
    assert.match(r1, /#1 저장/);
    const r2 = text(
      await client.callTool({
        name: 'remember',
        arguments: { kind: 'preference', content: '회의는 오후 2시 이후를 선호한다.', supersedes: [1], importance: 4 },
      }),
    );
    assert.match(r2, /무효 처리: #1/);

    const found = text(await client.callTool({ name: 'recall', arguments: { query: '회의 시간 선호' } }));
    assert.match(found, /오후 2시/);
    assert.doesNotMatch(found, /오전 10시/);

    const bad = await client.callTool({ name: 'update_profile', arguments: { content: '가'.repeat(5000), reason: 'x' } });
    assert.equal(bad.isError, true);

    const stats = JSON.parse(text(await client.callTool({ name: 'stats', arguments: {} })));
    assert.equal(stats.memoriesActive, 1);
    assert.equal(stats.memoriesInvalidated, 1);
    // 없으면 놓치는 실수: 비서가 덧붙인 말이 사용자 결정으로 기억에 남는다(2026-11-13 사용자 결정: 결정은 사용자 원문 발췌와 함께, 프로그램이 글자 그대로 있는지 확인).
    const noQuote = await client.callTool({ name: 'remember', arguments: { kind: 'decision', content: '회의는 화요일로 정했다.' } });
    assert.equal(noQuote.isError, true);
    assert.match(text(noQuote), /quote/);
    const pending = text(await client.callTool({ name: 'remember', arguments: { kind: 'decision', content: '회의는 화요일로 정했다.', quote: '화요일로 하자' } }));
    assert.match(pending, /#3 저장/);

    // Simple job → shared quick folder, created on first use.
    const quick = text(
      await client.callTool({
        name: 'create_task',
        arguments: { quick: true, name: 'cafe-intro', title: '카페 소개', goal: '소개 페이지', done_criteria: ['끝낸다'], proof: ['p'] },
      }),
    );
    assert.match(quick, /업무 #1 준비됨 — 공간 #1 간단한 결과물 모음/);
    assert.ok(quick.includes(path.join(workspaces, 'quick-outputs')), 'quick folder lands under SECRETARY_WORKSPACE_ROOT');
    assert.match(quick, /업무 폴더: output\/research\/\d{8}-cafe-intro\//);
    // A second quick job reuses the same folder.
    assert.match(
      text(await client.callTool({ name: 'create_task', arguments: { quick: true, name: 'memo', title: '메모', goal: 'g', done_criteria: ['x'], proof: ['p'] } })),
      /공간 #1 /,
    );

    // Team workspace, reused by id.
    const ws = text(
      await client.callTool({
        name: 'create_workspace',
        arguments: {
          kind: 'team', name: 'web-team', title: '웹페이지 제작팀', purpose: '웹페이지 제작',
          agents: [{ name: 'developer', description: '코드', prompt: '코드를 쓴다.' }],
        },
      }),
    );
    assert.match(ws, /공간 #2 생성/);
    const onTeam = text(
      await client.callTool({ name: 'create_task', arguments: { workspace_id: 2, name: 'landing', title: '랜딩', goal: 'g', done_criteria: ['x'], proof: ['p'] } }),
    );
    assert.match(onTeam, /업무 #3 준비됨 — 공간 #2 웹페이지 제작팀/);
    assert.match(text(await client.callTool({ name: 'list_workspaces', arguments: {} })), /공간 #2 \[팀: developer\] 웹페이지 제작팀 · 업무 1건/);

    for (const args of [
      { name: 'Bad Name', quick: true, title: 'x', goal: 'x', done_criteria: ['x'], proof: ['p'] },
      { name: 'both', quick: true, workspace_id: 2, title: 'x', goal: 'x', done_criteria: ['x'], proof: ['p'] },
      { name: 'neither', title: 'x', goal: 'x', done_criteria: ['x'], proof: ['p'] },
      { name: 'missing', workspace_id: 99, title: 'x', goal: 'x', done_criteria: ['x'], proof: ['p'] },
    ]) {
      assert.equal((await client.callTool({ name: 'create_task', arguments: args })).isError, true, args.name);
    }

    await client.callTool({ name: 'update_task', arguments: { id: 3, status: 'running', session_ref: 'local_x' } });
    assert.match(text(await client.callTool({ name: 'list_tasks', arguments: { status: 'running' } })), /업무 #3 \[running\] 랜딩 — 웹페이지 제작팀\(팀\)/);
    assert.match(text(await client.callTool({ name: 'get_task', arguments: { id: 3 } })), /REPORT\.md 아직 없음/);
    assert.doesNotMatch(text(await client.callTool({ name: 'update_task', arguments: { id: 3, status: 'running' } })), /주요 현안/);
    assert.match(text(await client.callTool({ name: 'update_task', arguments: { id: 3, status: 'done', result: '끝' } })), /\[done\][\s\S]*\n주요 현안을 고칠지 확인: .*set_main_agenda/);

    assert.match(text(await client.callTool({ name: 'set_main_agenda', arguments: { name: '랜딩', state: '진행 중', note: '초안' } })), /주요 현안 고침: 랜딩 → 진행 중\n- \[#1\] 랜딩 — 진행 중 \(초안\)/);
    assert.match(text(await client.callTool({ name: 'set_main_agenda', arguments: { name: '랜딩', state: '진행 중', note: '초안', seen_id: 1 } })), /바뀐 것 없음/);
    // The optimistic lock (main-agenda.test.ts) reaches the caller: a stale seen_id is an error saying what changed.
    await client.callTool({ name: 'set_main_agenda', arguments: { name: '랜딩', state: '사용자 차례', seen_id: 1 } });
    const stale = await client.callTool({ name: 'set_main_agenda', arguments: { name: '랜딩', state: '보류', seen_id: 1 } });
    assert.equal(stale.isError, true);
    assert.match(text(stale), /그 사이 이 줄이 바뀌었어요: 랜딩 \(본 줄 #1, 지금 #2 사용자 차례\)/);
    assert.match(text(await client.callTool({ name: 'list_main_agenda', arguments: {} })), /^- \[#2\] 랜딩 — 사용자 차례 · /);
    assert.match(text(await client.callTool({ name: 'list_main_agenda', arguments: { name: '랜딩' } })), /진행 중 \(초안\)\n.*사용자 차례/);
    assert.equal((await client.callTool({ name: 'set_main_agenda', arguments: { name: '없음', state: '끝남' } })).isError, true);
  } finally {
    await client.close();
  }
});

test('MCP server --readonly: only recall and search_log, and recalls write nothing', async () => {
  const db = path.join(tempDir(), 'ro.db');
  const s = testStore(db);
  const { id } = s.remember({ kind: 'fact', content: '알림 앱 기본값은 켜짐이다.' });
  const usageRows = () => s.stats().injectedTokensLast7d;
  const before = usageRows();
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts'), '--readonly'],
      env: { ...(process.env as Record<string, string>), SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' },
    }),
  );
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['recall', 'search_log']);
    assert.match(text(await client.callTool({ name: 'recall', arguments: { query: '알림 앱 기본값' } })), /켜짐/);
    assert.match(text(await client.callTool({ name: 'recall', arguments: { ids: [id] } })), /켜짐/);
    const r = await client.callTool({ name: 'remember', arguments: { kind: 'fact', content: 'x' } });
    assert.equal(r.isError, true);
    assert.equal(s.getMemory(id)?.access_count, 0, 'readonly recall does not touch memories');
    assert.equal(usageRows(), before, 'readonly recall does not log usage');
  } finally {
    await client.close();
  }
});

// [늘 남김] 없으면 놓치는 실수: 읽기 전용 서버(run-job·업무 세션)가 옛 DB를 옮기거나 없는 DB를 새로 만든다(DB 옮기기).
test('MCP server --readonly opens the DB read-only: an old one is not migrated, a missing one is not made', async () => {
  const dir = tempDir();
  const old = path.join(dir, 'old.db');
  const s = testStore(old, 10);
  s.remember({ kind: 'fact', content: '옛 DB의 기억이다.' });
  s.db.close();
  const version = () => {
    const raw = testStore(old, 0).db;
    const v = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    raw.close();
    return v;
  };
  for (const [db, query] of [[old, '옛 DB'], [path.join(dir, 'none.db'), '아무거나']] as const) {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts'), '--readonly'],
        env: { ...(process.env as Record<string, string>), SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' },
      }),
    );
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['recall', 'search_log']);
      await client.callTool({ name: 'recall', arguments: { query } });
    } finally {
      await client.close();
    }
  }
  assert.equal(version(), 10, 'still on its old schema');
  assert.ok(!fs.existsSync(path.join(dir, 'none.db')), 'no DB made');
});

// [늘 남김] 없으면 놓치는 실수: 기억 정리 보고의 개수(새 기억·대체·무효·현안·프로필)를 모델이 세어 틀리거나(2026-11-12 비교 시험:
// 보고 33개, DB 37개), 같은 때 비서가 대화 중 저장한 기억까지 세어, 비서가 사용자에게 틀린 숫자를 전한다.
test('MCP server: get_unconsolidated_log hands out whole messages, a long one part by part; the consolidation run counts only its own writes', async () => {
  const db = path.join(tempDir(), 'log.db');
  const s = testStore(db);
  const long = 'ㄱ'.repeat(20_000) + 'ㄴ'.repeat(20_000) + '끝';
  s.appendLog(
    ['짧은 말', '가'.repeat(1500), long, '다음 말'].map((content, n) => ({
      // A minute ahead: the candidates citing these rows are said after the memories the test saves (the time a verdict compares).
      session_id: 's', message_uuid: `m${n}`, role: n % 2 ? 'assistant' : 'user', content, created_at: new Date(Date.now() + 60_000 + n).toISOString(),
    })) as Parameters<Store['appendLog']>[0],
  );
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts'), '--staff', 'memory-consolidation'],
      env: { ...(process.env as Record<string, string>), SECRETARY_DB: db, SECRETARY_SEMANTIC_SEARCH: 'off' },
    }),
  );
  const next = async () => text(await client.callTool({ name: 'get_unconsolidated_log', arguments: { budget_tokens: 20000 } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${text(r)}`);
  };
  const mark = (id: string) => client.callTool({ name: 'mark_consolidated', arguments: { through_log_id: Number(id) } });
  // The secretary's own memories, one before the run and one while it runs (its own server has no --staff).
  const old = s.remember({ kind: 'fact', content: '옛 사실: 회의는 월요일이다' }).id;
  const wrong = s.remember({ kind: 'fact', content: '틀린 사실: 고양이 이름은 나비다' }).id;
  try {
    let r = await next();
    assert.ok(r.includes('가'.repeat(1500)), 'a 1,500-char reply comes whole');
    assert.match(r, /through_log_id=2 · 남은 미정리 2건$/);
    await mark('2');
    r = await next();
    assert.match(r, /\[log #3 .*\] \(1\/3 부분\)/);
    assert.match(r, /through_log_id=2 · 남은 미정리 2건\n로그 #3의 다음 부분이 남았다/);
    await mark('2');
    assert.match(await next(), /\(2\/3 부분\)\nㄴ/);
    r = await next();
    assert.match(r, /\(3\/3 부분\)\n끝\n\nthrough_log_id=3 · 남은 미정리 1건$/);
    await mark('3');
    assert.match(await next(), /다음 말/);
    // Memory candidates go through propose_memory → judge_memory (memory/consolidate-verdicts.ts): every close memory listed gets a verdict.
    const propose = async (content: string) => {
      const r = text(await client.callTool({ name: 'propose_memory', arguments: { kind: 'fact', content, source_log_id: 1 } }));
      return { key: /후보 (C\d+)/.exec(r)![1], near: [...r.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1])) };
    };
    const refused = async (name: string, args: Record<string, unknown>) => assert.ok((await client.callTool({ name, arguments: args })).isError, `${name} is refused`);
    const report = (await runConsolidate(s, 'idle', async () => {
      const c1 = await propose('정리 담당이 저장한 첫 사실: 사용자는 차를 좋아한다');
      await call('judge_memory', { candidate: c1.key, about: '사용자', duration: 'lasting', verdicts: c1.near.map((id) => ({ id, observation_about: '기억', verdict: 'unrelated' })) });
      const c2 = await propose('바뀐 사실: 회의는 화요일이다');
      assert.ok(c2.near.includes(old), 'the old meeting day is listed as close');
      await call('judge_memory', { candidate: c2.key, about: '회의', duration: 'lasting', verdicts: c2.near.map((id) => ({ id, observation_about: '회의', verdict: id === old ? 'changes' : 'unrelated' })) });
      s.remember({ kind: 'fact', content: '비서가 대화 중 같은 때 저장한 사실: 점심은 국수였다' });
      await call('remember', { kind: 'summary', content: '주제 요약', tags: ['비서', '요약'] });
      // On this server remember takes summaries only and forget is refused: an old state ends through a judged candidate.
      await refused('remember', { kind: 'fact', content: '판정 없이 저장하려는 사실', allow_similar: true });
      await refused('forget', { id: wrong, reason: '틀림' });
      const c3 = await propose('판정하지 않고 둔 후보');
      await refused('mark_consolidated', { through_log_id: 4 });
      await call('judge_memory', { candidate: c3.key, about: '후보', duration: 'lasting', verdicts: [], withdraw_reason: '시험' });
      await call('set_main_agenda', { name: '이사 준비', state: '진행 중' });
      await call('update_profile', { content: '# 프로필', reason: '시험' });
      await mark('4');
      return '정리 보고';
    })).report!;
    assert.equal(report.ok, true);
    assert.equal(report.text.split('\n\n')[0], '정리 보고');
    assert.ok(s.getMemory(old)!.superseded_by, 'the changed memory is replaced');
    assert.equal(s.getMemory(wrong)!.valid_to, null, 'forget was refused');
    // A candidate dropped without a verdict is counted with its reason (C10).
    assert.match(report.text, /\[프로그램이 센 이번 정리 결과\] 새 기억 2개 · 대체 1개 · 무효 0개 · 판정 없이 버린 후보 1개 · 주제 요약 1개 · 주요 현안 고친 줄 1개 · 프로필 갱신함\(v\d+\)\n새 기억 번호: #\d+, #\d+\n버린 후보: C3: 시험$/);
  } finally {
    await client.close();
  }
});
