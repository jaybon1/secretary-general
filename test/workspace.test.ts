import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createWorkspaceFolder, type TaskSpec, type WorkspaceSpec } from '../src/workspace/workspace-create.ts';
import { tempDir, testStore } from './helpers.ts';

const NOW = '2026-10-20T15:30:00Z'; // 2026-10-21 00:30 KST

const team = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  kind: 'team',
  name: 'web-team',
  title: '웹페이지 제작팀',
  purpose: '웹페이지·랜딩 페이지 제작',
  agents: [
    { name: 'designer', description: '화면 구성이 필요할 때', prompt: '레이아웃을 잡는다.', model: 'sonnet', tools: ['Read', 'Write'] },
    { name: 'developer', description: 'HTML/CSS를 작성할 때', prompt: '코드를 쓴다.' },
  ],
  ...over,
});

const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  name: 'cafe-intro',
  title: '카페 소개 페이지',
  goal: '카페를 소개하는 한 장짜리 페이지를 만든다.',
  context: '사용자는 시각을 24시 기준으로 말하길 원한다.',
  doneCriteria: ['index.html 하나로 열린다', '모바일에서도 읽힌다'],
  proof: ['index.html을 열면 카페 사진과 소개 글이 보인다'],
  ...over,
});

test('a team workspace gets a dated folder, a charter, role files and an output dir', () => {
  const parent = tempDir();
  const ws = createWorkspaceFolder(team({ parentDir: parent }), NOW);
  assert.equal(ws.folder, path.join(parent, 'web-team-20261021'));
  assert.deepEqual(ws.files, ['AGENTS.md', 'CLAUDE.md', '.claude/agents/designer.md', '.claude/agents/developer.md', 'notes/history.md', 'notes/history/.gitkeep', 'MEMORY.md', 'notes/pending/.gitkeep', '.gitignore', 'secretary-link.local.json']);
  assert.ok(fs.existsSync(path.join(ws.folder, '.git')), 'each workspace is a local git repo');
  assert.match(fs.readFileSync(path.join(ws.folder, 'AGENTS.md'), 'utf8'), /git commit -m/, 'workers commit once per task');
  assert.ok(fs.statSync(path.join(ws.folder, 'output')).isDirectory());
  const history = fs.readFileSync(path.join(ws.folder, 'notes', 'history.md'), 'utf8');
  assert.match(history, /지금 상태만 둔다\(2,000자 안\)[\s\S]*grep -h "\^## " notes\/history\/\*\.md \| tail -20[\s\S]*## 현재 상태/, 'history.md holds the state; entries go to monthly files');

  assert.equal(fs.readFileSync(path.join(ws.folder, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n', 'Claude Code imports the rules other CLIs read');
  const charter = fs.readFileSync(path.join(ws.folder, 'AGENTS.md'), 'utf8');
  assert.match(charter, /^# 웹페이지 제작팀/);
  assert.match(charter, /## 팀[\s\S]*`developer`: HTML\/CSS를 작성할 때/);
  assert.match(charter, /output\/products\/<제품>\/[\s\S]*output\/records\/<제품>\/<YYYYMMDD>-<업무이름>\/[\s\S]*output\/research\//);
  assert.match(charter, /AskUserQuestion\)을 쓰지 않는다/, 'questions must reach the secretary, not a popup');
  assert.match(charter, /`\[질문\]`/);
  assert.match(charter, /`notes\/history\/<YYYY-MM>\.md`[^\n]*이 업무 항목을 덧붙인다[\s\S]*`notes\/history\.md`의 "현재 상태"[^\n]*2,000자 안/, 'workers append each task to the monthly file and keep the state short');
  assert.doesNotMatch(charter, /history\.md`에 이 업무 항목을/, 'no more appending to the state file');
  assert.match(charter, /## 일하는 방식[\s\S]*workspaces[\\/]_sandbox[\\/]<공간폴더이름>-<업무번호>[\s\S]*지웠는지 적는다\. 이유: 위쪽 폴더에 규칙 파일·git이 없어/, 'test folders live outside every workspace');
  assert.match(charter, /## 일하는 방식[\s\S]*되돌릴 수 없는 단계[^\n]*`\[질문\]`으로 넘긴다\. 실행은 비서가 사용자 승인을 받아 한다/, 'irreversible steps are handed to the secretary');
  assert.match(charter, /## 일하는 방식[\s\S]*나중까지 남는 것[^\n]*"장기적 관점의 제안"을 나란히 적는다[^\n]*"장기적 관점으로 봐도 같음"[^\n]*"개선 후보"에 적기만/, 'lasting changes get a long-term option beside the current one');
  assert.match(charter, /## 일하는 방식[\s\S]*업무를 끝내기 전에 뒤에서 도는 명령을 끝내거나 멈춘다\(TaskStop\)\. 남으면 비서가 완료를 늦게 알게 된다\./, 'workers stop leftover background commands before finishing');
  assert.match(charter, /## 끝낼 때[\s\S]*- 장기적 관점의 제안:[^\n]*\n- 개선 후보: 맡은 범위 밖/, 'the report has the long-term and out-of-scope lines');
  assert.match(charter, /## 일하는 방식[\s\S]*비서 기억 읽기 도구\(`recall`·`search_log`\)가 있으면[^\n]*`search_log`로 대화 원문을 조회한다\. 쓰기 도구는 없으니 남길 사실은 보고서에 적는다/, 'memory is read with recall/search_log when the tools are there');

  assert.equal(
    fs.readFileSync(path.join(ws.folder, '.claude', 'agents', 'designer.md'), 'utf8'),
    '---\nname: designer\ndescription: 화면 구성이 필요할 때\nmodel: sonnet\ntools: Read, Write\n---\n\n레이아웃을 잡는다.\n',
  );
});

// [늘 남김] 없으면 놓치는 실수: 옛 DB의 업무 폴더가 작업 공간으로 옮겨지지 않아 업무 이력을 잃는다(DB 옮기기).
test('migration 4 turns each pre-existing task folder into a workspace', () => {
  const file = path.join(tempDir(), 'v3.db');
  const raw = new DatabaseSync(file);
  // Minimal v3 shape: what migration 4 reads, plus what later migrations touch.
  raw.exec(`
    CREATE TABLE memories (id INTEGER PRIMARY KEY, kind TEXT, content TEXT, tags TEXT, importance INTEGER, valid_from TEXT,
      valid_to TEXT, superseded_by INTEGER, invalid_reason TEXT, source_session TEXT, source_log_id INTEGER, created_at TEXT,
      last_accessed_at TEXT, access_count INTEGER);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT, title TEXT, folder TEXT UNIQUE, goal TEXT, agents TEXT,
      status TEXT, session_ref TEXT, result TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE raw_log (id INTEGER PRIMARY KEY, session_id TEXT, message_uuid TEXT UNIQUE, role TEXT, content TEXT, created_at TEXT);
    CREATE VIRTUAL TABLE raw_log_fts USING fts5 (terms);
    CREATE VIRTUAL TABLE memories_fts USING fts5 (terms);
    CREATE VIRTUAL TABLE memories_vocab USING fts5vocab (memories_fts, 'row');
    CREATE TABLE usage_log (id INTEGER PRIMARY KEY, event TEXT NOT NULL, tokens INTEGER NOT NULL, detail TEXT, created_at TEXT NOT NULL);
    INSERT INTO tasks VALUES (7, 'demo', '데모', '/w/demo-20261016', '데모 업무', 'a,b', 'done', 's1', 'ok', 't', 't');
  `);
  raw.close();

  // Run only migration 4 on top of it by pretending 0–3 already ran.
  const pre = new DatabaseSync(file);
  pre.exec('PRAGMA user_version = 3');
  pre.close();
  const s = testStore(file);
  const w = s.listWorkspaces()[0];
  assert.equal(w?.kind, 'team');
  assert.equal(w?.folder, '/w/demo-20261016');
  const t = s.getTask(7);
  assert.equal(t?.workspace_id, w?.id);
  assert.equal(t?.output_dir, '.');
  assert.equal(t?.result, 'ok');
});
