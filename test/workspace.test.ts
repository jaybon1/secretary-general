import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import {
  QUICK_SPEC,
  createTaskFolder,
  createWorkspaceFolder,
  locateWorkspaceFolder,
  readReport,
  renderCharter,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/workspace/folders.ts';
import { tempDir, tempStore, testStore } from './helpers.ts';

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
  assert.deepEqual(ws.files, ['AGENTS.md', 'CLAUDE.md', '.claude/agents/designer.md', '.claude/agents/developer.md', 'notes/history.md', 'notes/history/.gitkeep', 'MEMORY.md', 'notes/pending/.gitkeep', '.gitignore', 'secretary.json']);
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
  assert.match(charter, /## 일하는 방식[\s\S]*나중까지 남는 것[^\n]*"장기적 관점의 제안"을 나란히 적는다[^\n]*"장기적 관점으로 봐도 같음"[^\n]*"개선 후보"로만 적는다/, 'lasting changes get a long-term option beside the current one');
  assert.match(charter, /## 일하는 방식[\s\S]*업무를 끝내기 전에 뒤에서 도는 명령을 끝내거나 멈춘다\(TaskStop\)\. 남으면 비서가 완료를 늦게 알게 된다\./, 'workers stop leftover background commands before finishing');
  assert.match(charter, /## 끝낼 때[\s\S]*- 장기적 관점의 제안:[^\n]*\n- 개선 후보: 맡은 범위 밖/, 'the report has the long-term and out-of-scope lines');
  assert.match(charter, /## 일하는 방식[\s\S]*비서 기억 읽기 도구\(`recall`·`search_log`\)가 있으면[^\n]*`search_log`로 대화 원문을 펼친다\. 쓰기 도구는 없으니 남길 사실은 보고서에 적는다/, 'memory is read with recall/search_log when the tools are there');

  assert.equal(
    fs.readFileSync(path.join(ws.folder, '.claude', 'agents', 'designer.md'), 'utf8'),
    '---\nname: designer\ndescription: 화면 구성이 필요할 때\nmodel: sonnet\ntools: Read, Write\n---\n\n레이아웃을 잡는다.\n',
  );
});

test('the quick folder has a fixed name and no team', () => {
  const ws = createWorkspaceFolder({ ...QUICK_SPEC, parentDir: tempDir() }, NOW);
  assert.equal(path.basename(ws.folder), 'quick-outputs');
  assert.deepEqual(ws.files, ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'secretary.json'], 'quick tasks are unrelated, so no shared history');
  const charter = fs.readFileSync(path.join(ws.folder, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(charter, /history\.md|notes\/history|스킬과 기억|notes\/pending|고친 스킬/, 'no learning files in the shared quick folder');
  assert.match(charter, /_sandbox/, 'quick tasks keep test folders out too');
  assert.match(charter, /역할 정의는 직접 고치지 않는다/);
  assert.match(charter, /"장기적 관점의 제안"을 나란히 적는다[\s\S]*- 개선 후보:/, 'quick tasks report long-term options too');
  assert.match(charter, /비서 기억 읽기 도구\(`recall`·`search_log`\)가 있으면/, 'quick tasks can read memory too');
});

test('a non-quick workspace keeps what it learns in skills, MEMORY.md and pending proposals', () => {
  const ws = createWorkspaceFolder({ kind: 'solo', name: 'insta', title: '인스타 계정', purpose: '게시물 제작', parentDir: tempDir() }, NOW);
  assert.ok(fs.statSync(path.join(ws.folder, 'notes', 'pending')).isDirectory());
  // Skills go in .agents/skills (its .claude/skills link is made when the secretary writes secretary.json), listed by the CLI, not in AGENTS.md.
  assert.ok(fs.lstatSync(path.join(ws.folder, '.claude', 'skills')).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(ws.folder, '.gitignore'), 'utf8'), /^\/\.claude\/skills$/m);
  const memory = fs.readFileSync(path.join(ws.folder, 'MEMORY.md'), 'utf8');
  assert.match(memory, /^# 인스타 계정 사실 메모[\s\S]*"~이다"[\s\S]*2,000자/);

  const charter = fs.readFileSync(path.join(ws.folder, 'AGENTS.md'), 'utf8');
  assert.match(charter, /MEMORY\.md`와 `notes\/history\.md`\(지금 상태\)를 읽고[\s\S]*맞는 스킬\(`\.agents\/skills\/`, 공통 스킬은 `common-<이름>`\)이 있으면 먼저 읽고 따른다[^\n]*통째로 열지 말고 찾아 읽는다/);
  assert.match(charter, /## 스킬과 기억[\s\S]*\.agents\/skills\/<이름>\/SKILL\.md[\s\S]*"규칙 \+ 이유 한 줄"[\s\S]*notes\/pending\/<YYYYMMDD>-<짧은이름>\.md[\s\S]*공통 스킬\(`common-<이름>` 스킬, 원본은 `workspaces\\_skills`[\s\S]*읽기만 한다[\s\S]*남기지 않는 것: 환경 탓 실패[\s\S]*## 일하는 방식/);
  assert.ok(!charter.includes('스킬 목록(') && !charter.includes('- 아직 없음'), 'no skill list in the charter: the CLI lists skills by their description');
  assert.match(charter, /## 끝낼 때[\s\S]*- 고친 스킬, 남긴 제안:/);
  assert.match(charter, /역할 정의, `MEMORY\.md`는 직접 고치지 않는다\. 스킬은[^\n]*교정을 반영할 때만 고친다/);
  assert.doesNotMatch(charter, /지난 업무에서 배운 점/);
});

test('each task gets its own dated folder under research/ or records/<product>/, never overwriting', () => {
  const ws = createWorkspaceFolder(team({ parentDir: tempDir() }), NOW);
  const first = createTaskFolder(ws.folder, task(), NOW);
  assert.equal(first.outputDir, 'output/research/20261021-cafe-intro');
  assert.deepEqual(first.files, ['output/research/20261021-cafe-intro/TASK.md']);
  const brief = fs.readFileSync(path.join(ws.folder, first.outputDir, 'TASK.md'), 'utf8');
  assert.match(brief, /^# 카페 소개 페이지/);
  assert.match(brief, /- 모바일에서도 읽힌다/);
  assert.match(brief, /24시/);
  assert.match(brief, /## 증거[\s\S]*- index\.html을 열면/);
  assert.doesNotMatch(brief, /## 위험|## 진행 방식|## 제품/, 'empty sections stay out');

  const careful = createTaskFolder(ws.folder, task({ name: 'fix', risks: ['기존 링크가 깨질 수 있다'], planFirst: true, lockTests: true }), NOW);
  const strict = fs.readFileSync(path.join(ws.folder, careful.outputDir, 'TASK.md'), 'utf8');
  assert.match(strict, /## 위험\n\n- 기존 링크가 깨질 수 있다/);
  assert.match(strict, /계획 먼저: 예[\s\S]*테스트 잠금: 예/);

  assert.equal(createTaskFolder(ws.folder, task(), NOW).outputDir, 'output/research/20261021-cafe-intro-2');
  assert.equal(createTaskFolder(ws.folder, task({ name: 'other' }), NOW).outputDir, 'output/research/20261021-other');

  const made = createTaskFolder(ws.folder, task({ name: 'popup', product: 'jump-ext' }), NOW);
  assert.equal(made.outputDir, 'output/records/jump-ext/20261021-popup');
  assert.ok(fs.statSync(path.join(ws.folder, 'output', 'products', 'jump-ext')).isDirectory(), 'the product folder exists for the worker to edit in place');
  assert.match(fs.readFileSync(path.join(ws.folder, made.outputDir, 'TASK.md'), 'utf8'), /## 제품\n\n제품 본체는 `output\/products\/jump-ext\/`/);
  assert.throws(() => createTaskFolder(ws.folder, task({ name: 'x', product: 'Bad' })), /제품 이름/);

  assert.equal(readReport(ws.folder, first.outputDir), null);
  fs.writeFileSync(path.join(ws.folder, first.outputDir, 'REPORT.md'), '# 결과\n완료');
  assert.match(readReport(ws.folder, first.outputDir) ?? '', /완료/);
});

test('rejects bad names, wrong team shapes, missing parents and the secretary folder itself', () => {
  const parent = tempDir();
  assert.throws(() => createWorkspaceFolder(team({ name: '웹팀', parentDir: parent })), /영문 소문자/);
  assert.throws(() => createWorkspaceFolder(team({ name: '../escape', parentDir: parent })), /영문 소문자/);
  assert.throws(() => createWorkspaceFolder(team({ agents: [], parentDir: parent })), /역할이 하나 이상/);
  assert.throws(() => createWorkspaceFolder({ ...team(), kind: 'solo', parentDir: parent }), /팀 공간에만/);
  const dup = { name: 'a', description: 'x', prompt: 'y' };
  assert.throws(() => createWorkspaceFolder(team({ agents: [dup, dup], parentDir: parent })), /겹칩니다/);
  assert.throws(() => createWorkspaceFolder(team({ parentDir: path.join(parent, 'nope') })), /상위 폴더가 없습니다/);
  assert.throws(() => createWorkspaceFolder(team({ parentDir: path.join(PROJECT_ROOT, 'src') })), /비서 폴더 안/);

  const ws = createWorkspaceFolder(team({ parentDir: parent }), NOW);
  assert.throws(() => createTaskFolder(ws.folder, task({ doneCriteria: [] })), /완료 기준/);
  assert.throws(() => createTaskFolder(ws.folder, task({ proof: [] })), /증거/);
  assert.throws(() => createTaskFolder(ws.folder, task({ name: 'Bad Name' })), /영문 소문자/);
});

test('one team workspace takes many tasks, each tracked through its lifecycle', () => {
  const s = tempStore();
  const w = s.createWorkspace({ kind: 'team', name: 'web-team', title: '웹페이지 제작팀', purpose: '웹페이지 제작', folder: '/x/web-team', agents: ['designer', 'developer'] });
  const t1 = s.createTask({ workspaceId: w.id, name: 'a', title: 'A', goal: 'g', outputDir: 'output/20261021-a' });
  const t2 = s.createTask({ workspaceId: w.id, name: 'b', title: 'B', goal: 'g', outputDir: 'output/20261021-b' });
  assert.equal(t1.status, 'ready');

  const listed = s.listWorkspaces();
  assert.equal(listed[0]?.task_count, 2);
  assert.equal(listed[0]?.agents, 'designer,developer');
  assert.equal(s.quickWorkspace(), undefined);

  assert.equal(s.updateTask(t1.id, { status: 'running', sessionRef: 'local_abc' })?.session_ref, 'local_abc');
  const done = s.updateTask(t1.id, { status: 'done', result: '페이지 완성' });
  assert.equal(done?.status, 'done');
  assert.equal(done?.session_ref, 'local_abc', 'unspecified fields are kept');
  assert.equal(done?.folder, '/x/web-team');
  assert.equal(done?.workspace_kind, 'team');
  assert.equal(s.updateTask(999, { status: 'done' }), undefined);

  assert.deepEqual(s.listTasks({ status: 'running' }), []);
  assert.deepEqual(s.listTasks({ workspaceId: w.id }).map((t) => t.id).sort(), [t1.id, t2.id]);
});

test('an archived workspace leaves the list but keeps its task history', () => {
  const s = tempStore();
  const w = s.createWorkspace({ kind: 'team', name: 'old-team', title: '옛 팀', purpose: '직무별 팀', folder: '/x/old-team', agents: ['qa'] });
  const t = s.createTask({ workspaceId: w.id, name: 'a', title: 'A', goal: 'g', outputDir: 'output/20261021-a' });

  const archived = s.archiveWorkspace(w.id, '/x/old/old-team');
  assert.ok(archived.archived_at);
  assert.deepEqual(s.listWorkspaces(), []);
  assert.equal(s.getTask(t.id)?.folder, '/x/old/old-team', 'old tasks follow the moved folder');
  assert.throws(() => s.archiveWorkspace(w.id, '/x/elsewhere'), /이미 보관/);
});

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

test('locateWorkspaceFolder: finds a moved workspace by name beside the secretary', () => {
  const root = tempDir();
  const here = path.join(root, 'quick-outputs');
  fs.mkdirSync(here);
  assert.equal(locateWorkspaceFolder(here, root), here);
  const elsewhere = path.join(tempDir(), 'gone', 'quick-outputs');
  assert.equal(locateWorkspaceFolder(elsewhere, root), here, 'old absolute path from another computer');
  assert.equal(locateWorkspaceFolder(path.join(tempDir(), 'web-team-20261016'), root), null);
});

test('only code workspaces get the code rules', () => {
  const spec: WorkspaceSpec = { kind: 'solo', name: 'ext', title: '확장', purpose: '크롬 확장' };
  assert.doesNotMatch(renderCharter(spec), /코드를 쓸 때/);
  assert.match(renderCharter({ ...spec, code: true }), /## 코드를 쓸 때[\s\S]*## 물어볼 때/);
});

test('code scale adds rules on top of the small set', () => {
  const spec: WorkspaceSpec = { kind: 'solo', name: 'app', title: '앱', purpose: '웹 앱', code: true };
  const small = renderCharter(spec);
  assert.doesNotMatch(small, /### (중|대)규모/);
  const medium = renderCharter({ ...spec, scale: 'medium' });
  assert.match(medium, /## 코드를 쓸 때[\s\S]*### 중규모 공간[\s\S]*git switch -c task\/[\s\S]*## 검증/);
  assert.doesNotMatch(medium, /GLOSSARY/);
  const large = renderCharter({ ...spec, scale: 'large' });
  assert.match(large, /### 대규모 공간[\s\S]*verify[\s\S]*GLOSSARY\.md[\s\S]*worktree/);
  assert.match(large, /결정 기록도 업무 항목과 함께 `notes\/history\/<YYYY-MM>\.md`에 덧붙인다/);
  assert.doesNotMatch(large, /결정 기록으로만/);
  assert.throws(() => createWorkspaceFolder({ ...spec, code: false, scale: 'medium', parentDir: tempDir() }), /코드 공간/);
});

test('every charter asks for pasted verification output; only non-quick ones call a checker', () => {
  const spec: WorkspaceSpec = { kind: 'solo', name: 'ext', title: '확장', purpose: '크롬 확장', verify: ['npm test'] };
  const charter = renderCharter(spec);
  assert.match(charter, /## 검증[\s\S]*- `npm test`[\s\S]*테스트가 아니라 코드를 고친다[\s\S]*고치지 말고 보고만 하라[\s\S]*## 물어볼 때/);
  assert.match(charter, /계획 먼저: 예/, 'plan-first tasks stop for approval');
  assert.match(renderCharter({ ...spec, verify: undefined }), /아직 정하지 않음/);
  assert.doesNotMatch(renderCharter(QUICK_SPEC), /확인 담당: 보고서를/);
});
