import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

test('MCP server: remember → recall → supersede → stats over stdio', async () => {
  const workspaces = tempDir();
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PROJECT_ROOT, 'src', 'mcp-server.ts')],
      env: {
        ...(process.env as Record<string, string>),
        SECRETARY_DB: path.join(tempDir(), 'mcp.db'),
        SECRETARY_WORKSPACE_ROOT: workspaces,
      },
    }),
  );
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      'create_task', 'create_workspace', 'forget', 'get_profile', 'get_task', 'get_unconsolidated_log', 'list_memories',
      'list_tasks', 'list_topics', 'list_workspaces', 'mark_consolidated', 'recall', 'remember', 'search_log', 'stats', 'update_profile',
      'update_task',
    ]);

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
  } finally {
    await client.close();
  }
});

test('MCP server: get_unconsolidated_log hands out whole messages, a long one part by part', async () => {
  const db = path.join(tempDir(), 'log.db');
  const s = new Store(openDb(db));
  const long = 'ㄱ'.repeat(20_000) + 'ㄴ'.repeat(20_000) + '끝';
  s.appendLog(
    ['짧은 말', '가'.repeat(1500), long, '다음 말'].map((content, n) => ({
      session_id: 's', message_uuid: `m${n}`, role: n % 2 ? 'assistant' : 'user', content, created_at: new Date(Date.now() + n).toISOString(),
    })) as Parameters<Store['appendLog']>[0],
  );
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PROJECT_ROOT, 'src', 'mcp-server.ts')],
      env: { ...(process.env as Record<string, string>), SECRETARY_DB: db, SECRETARY_EMBED: 'off' },
    }),
  );
  const next = async () => text(await client.callTool({ name: 'get_unconsolidated_log', arguments: { budget_tokens: 20000 } }));
  const mark = (id: string) => client.callTool({ name: 'mark_consolidated', arguments: { through_log_id: Number(id) } });
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
  } finally {
    await client.close();
  }
});
