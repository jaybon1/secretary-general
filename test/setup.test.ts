import assert from 'node:assert/strict';
import { fixAuxFolders } from '../src/setup/aux-folders.ts';
import { RUN_JOB_HOME, workspaceRootOf, writeLink } from '../src/workspace/secretary-link.ts';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, write } from './helpers.ts';
import { allSecretariesFile } from '../src/core/this-secretary.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { ENTRY_POINTS, entryPath, entryText, secretaryDirEnv, scriptPath, type EntryName } from '../src/core/paths.ts';
import { baseTaskNames, scheduledTaskNames } from '../src/core/features.ts';
import { ensureSecretaryId, SECRETARY_ID_ALPHABET, SECRETARY_ID_FILE, newSecretaryId, readSecretaryId, taskNameWith } from '../src/core/secretary-id.ts';
import { MODEL_FILES } from '../src/semantic-search/client.ts';
import { fixSkillLinks } from '../src/workspace/skill-links.ts';
import {
  checkSetup,
  taskNamesFor,
  saveReport,
  setupNotice,
  setupReminder,
  type Probe,
  type ProbeQuery,
  type Proc,
  type SetupOptions,
} from '../src/setup/setup-check.ts';

const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** The fixture copy's secretary id, and its task names (features.json name + id). */
const FIXTURE_ID = 'AB12';
const OLD = baseTaskNames(PROJECT_ROOT);
const SERVER_TASK = taskNameWith(OLD.server, FIXTURE_ID);
const BACKUP_TASK = taskNameWith(OLD.backup, FIXTURE_ID);
const IDLE_TASK = taskNameWith(OLD['idle-jobs'], FIXTURE_ID);
/** The fixture copy's folder variable: SECRETARY_<id>_DIR. */
const SECRETARY_DIR_ENV = secretaryDirEnv(FIXTURE_ID);

function serverProc(root: string, extra = '', pid = 100, script = scriptPath('remoteServer', root)): Proc {
  return { pid, name: 'powershell.exe', exe: PS, cmd: `"${PS}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.win32.normalize(script)}"${extra}` };
}

/** A complete install in a temp folder, with a fake probe that finds both tasks and the server window. */
function fixture(probe?: Partial<Probe>) {
  const root = tempDir();
  fs.copyFileSync(path.join(PROJECT_ROOT, 'features.json'), path.join(root, 'features.json'));
  write(path.join(root, SECRETARY_ID_FILE), `${FIXTURE_ID}\n`);
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { alpha: '1', '@scope/beta': '1' } }));
  write(path.join(root, 'node_modules', 'alpha', 'package.json'), '{}');
  write(path.join(root, 'node_modules', '@scope', 'beta', 'package.json'), '{}');
  // A skill in .agents/skills and its one link .claude/skills (a junction).
  write(path.join(root, '.agents', 'skills', 'delegate', 'SKILL.md'), '---\nname: delegate\ndescription: d\n---\n');
  fixSkillLinks(root);
  write(scriptPath('providers', root), JSON.stringify({ default: 'subscription' }));
  // The bin entries and the scripts they run; a config folder whose settings call them.
  for (const name of Object.keys(ENTRY_POINTS) as EntryName[]) {
    write(entryPath(name, root), entryText(name));
    write(scriptPath(ENTRY_POINTS[name], root));
  }
  const configDir = path.join(root, 'claude-config');
  write(path.join(configDir, 'settings.json'), JSON.stringify(usageSettings(root)));
  const modelPath = path.join(root, 'models', 'm');
  for (const f of MODEL_FILES) write(path.join(modelPath, f), 'x');
  // The worker files and their folders (workspaces/_staff/memory-consolidation, situation-board) and run-job's home (in this test process's workspaces folder).
  fs.cpSync(path.join(PROJECT_ROOT, 'src', 'staff'), path.join(root, 'src', 'staff'), { recursive: true });
  fixAuxFolders(root);
  // The workspaces folder is this process's, shared by the fixtures: its _run-job-home link is set to this root.
  writeLink(path.join(workspaceRootOf(root), RUN_JOB_HOME), root);
  const dbPath = path.join(root, 'test.db');
  write(dbPath);
  const queries: ProbeQuery[] = [];
  const opts: Partial<SetupOptions> = {
    root,
    dbPath,
    modelPath,
    keysDir: path.join(root, 'keys'),
    platform: 'win32',
    cacheFile: `${dbPath}.setup-check.json`,
    configDirs: [configDir],
    probe: async (q) => {
      queries.push(q);
      const env = Object.fromEntries((q.env ?? []).map((n) => [n, n === SECRETARY_DIR_ENV ? root : '']));
      return { tasks: Object.fromEntries(q.tasks.map((t) => [t, true])), procs: [serverProc(root)], env, ...probe };
    },
  };
  return { root, opts, queries, configDir };
}

/** User settings as scripts/usage/install-usage-guard.mjs writes them for this root (forward slashes). */
function usageSettings(root: string, entry = (n: EntryName) => entryPath(n, root).replace(/\\/g, '/')) {
  return {
    statusLine: { type: 'command', command: `node "${entry('usage-statusline.mjs')}"` },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${entry('usage-guard.mjs')}"`, timeout: 5 }] }] },
  };
}

const status = (r: { results: Array<{ id: string; status: string }> }) => Object.fromEntries(r.results.map((x) => [x.id, x.status]));

test('missing tasks raise the notice: items, fixes, the opening line and what the secretary does', async () => {
  const { opts } = fixture({ tasks: { [SERVER_TASK]: false, [BACKUP_TASK]: false, [IDLE_TASK]: false } });
  const report = await checkSetup(opts);
  assert.equal(status(report)['server-task'], 'missing');
  assert.equal(status(report)['backup-task'], 'missing');
  assert.equal(status(report)['idle-jobs-task'], 'missing');
  const notice = setupNotice(report.results);
  assert.match(notice, /^<secretary-setup>/);
  assert.match(notice, /<\/secretary-setup>$/);
  assert.match(notice, /\[server-task\] 비서 서버 자동 시작 예약 작업 → .*install-scheduled-tasks\.ps1 -Task server/);
  assert.match(notice, /\[backup-task\] 매일 DB 백업 예약 작업 → .*install-scheduled-tasks\.ps1 -Task backup/);
  assert.match(notice, /\[idle-jobs-task\] 쉬는 시간 작업 예약 작업[^\n]*→ .*install-scheduled-tasks\.ps1 -Task idle-jobs/);
  assert.match(notice, /비서 할 일: 매 답 맨 위에 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업, 쉬는 시간 작업 예약 작업\(상황판 미리 갱신, 기억 정리\)\. "설치 이어서 해 줘"라고 하시면 도와드릴게요'/);
  assert.match(notice, /setup-check/);
  // The prompt hook's reminder reuses the kept check: one short line.
  saveReport(report, opts.cacheFile!);
  const reminder = setupReminder(opts);
  assert.match(reminder, /^<secretary-setup>이 답 맨 위 한 줄로 '아직 설치가 덜 됐어요: 비서 서버 자동 시작 예약 작업, 매일 DB 백업 예약 작업, 쉬는 시간 작업 예약 작업\(상황판 미리 갱신, 기억 정리\)\./);
  assert.equal(reminder.split('\n').length, 1);
});


test('secretary id: made once (4 letters, no look-alikes), kept, read back; a broken file is replaced; task names carry it', () => {
  const root = tempDir();
  assert.equal(readSecretaryId(root), null);
  const first = ensureSecretaryId(root);
  assert.equal(first.created, true);
  assert.match(first.id!, /^[A-Z0-9]{4}$/);
  for (const ch of first.id!) assert.ok(SECRETARY_ID_ALPHABET.includes(ch));
  // 없으면 놓치는 실수: 새 번호가 모음으로 단어(KEYS, USAGE…)를 이뤄 ~/.secretary에 함께 쓰는 이름과 겹치거나, 모음 든 옛 번호를 못 읽는다.
  assert.ok(![...SECRETARY_ID_ALPHABET].some((ch) => 'AEIOUY01L'.includes(ch)), 'no vowels, no look-alikes');
  for (let k = 0; k < 24; k++) assert.doesNotMatch(newSecretaryId(), /[AEIOUY]/);
  assert.ok(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1'), 'utf8').includes(`$SecretaryIdAlphabet = '${SECRETARY_ID_ALPHABET}'`), 'the PowerShell side makes ids from the same letters');
  const old = tempDir();
  write(path.join(old, SECRETARY_ID_FILE), 'A3F9\n');
  assert.equal(readSecretaryId(old), 'A3F9', 'an id made before, with vowels, still reads');
  assert.deepEqual(ensureSecretaryId(old), { id: 'A3F9', created: false });
  assert.deepEqual(ensureSecretaryId(root), { id: first.id, created: false }, 'kept from then on');
  assert.equal(readSecretaryId(root), first.id);
  assert.equal(fs.readFileSync(path.join(root, SECRETARY_ID_FILE), 'utf8'), `${first.id}\n`);
  // One shape everywhere: upper case. A hand-written or older one (lower case, BOM, CRLF) reads in upper case without
  // writing; making sure of the id writes it again as `<ID>\n`. One that is not an id is replaced.
  write(path.join(root, SECRETARY_ID_FILE), '\uFEFFmy01\r\n');
  assert.equal(readSecretaryId(root), 'MY01');
  assert.equal(fs.readFileSync(path.join(root, SECRETARY_ID_FILE), 'utf8'), '\uFEFFmy01\r\n', 'reading does not write');
  assert.deepEqual(ensureSecretaryId(root), { id: 'MY01', created: false });
  assert.equal(fs.readFileSync(path.join(root, SECRETARY_ID_FILE), 'utf8'), 'MY01\n');
  write(path.join(root, SECRETARY_ID_FILE), 'Not An Id!');
  assert.equal(readSecretaryId(root), null);
  assert.equal(ensureSecretaryId(root).created, true);
  // Ids differ from install to install (24 draws, all the same would be a broken generator).
  assert.ok(new Set(Array.from({ length: 24 }, newSecretaryId)).size > 1);
  // Task names: the features.json name and the id; the name alone without an id.
  assert.equal(taskNameWith('Secretary Idle Jobs', 'A3F9'), 'Secretary Idle Jobs (A3F9)');
  assert.equal(taskNameWith('Secretary Idle Jobs', 'a3f9'), 'Secretary Idle Jobs (A3F9)');
  assert.equal(taskNameWith('Secretary Idle Jobs', null), 'Secretary Idle Jobs');
  fs.copyFileSync(path.join(PROJECT_ROOT, 'features.json'), path.join(root, 'features.json'));
  // A lower-case file (an earlier build) gives the same upper-case names.
  write(path.join(root, SECRETARY_ID_FILE), 'a3f9\n');
  const names = scheduledTaskNames(root);
  assert.equal(names.server, 'Secretary Remote Control (A3F9)');
  assert.equal(names.backup, 'Secretary DB Backup (A3F9)');
  assert.equal(names['idle-jobs'], 'Secretary Idle Jobs (A3F9)');
  assert.ok(Object.values(names).every((n) => n.endsWith(' (A3F9)')));
  assert.equal(taskNamesFor(root)['idle-jobs'], 'Secretary Idle Jobs (A3F9)');
});
