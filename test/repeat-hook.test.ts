// The repeat reminder (feature 'guards', src/guards/repeat-hook.ts): what counts as one kind of call, counting within a
// turn from a transcript read bit by bit, telling once per kind and turn, and the hook as Claude Code runs it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { callKind, callUnit, commandHead, runRepeatHook } from '../src/guards/repeat-hook.ts';
import { DEFAULT_REPEAT_LIMIT, repeatLimit } from '../src/guards/settings.ts';
import { readFeatures } from '../src/setup/features.ts';
import { tempDir } from './helpers.ts';

test('a shell command is known by its program and its subcommand or script', () => {
  assert.equal(commandHead('curl -s https://mail.example.com/api/1'), 'curl');
  assert.equal(commandHead('git log --oneline -3'), 'git log');
  assert.equal(commandHead('cd C:\\work; ego-browser open https://mail.example.com/inbox/12'), 'ego-browser open');
  assert.equal(commandHead('cd /c/work && node scripts/export.mjs --from 2026-10-01'), 'node export.mjs');
  assert.equal(commandHead('powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-job/run-job.ps1 -Model sonnet'), 'powershell run-job.ps1');
  assert.equal(commandHead('& "C:\\Program Files\\GitHub CLI\\gh.exe" api repos/x/y'), 'gh api');
  assert.equal(commandHead('$env:X = 1; python -X utf8 tools/read.py a.eml'), 'python read.py');
  assert.equal(commandHead('cdk deploy'), 'cdk deploy', 'a program whose name starts with cd is not cd');
  assert.equal(commandHead('cd x'), '');
});

test('looking at files from the shell and inline code are not a step; the step after them is', () => {
  for (const c of ['cat a.md', 'Get-Content a.txt', 'grep -n x a.py | head -5', 'ls output/ && wc -l a.txt', "sed -i 's/a/b/' a.py", "cat >> PROGRESS.md <<'EOF'\n- 4 끝: python x.py\nEOF"])
    assert.equal(commandHead(c), '', c);
  for (const c of ['python -I -c "print(1)"', "python -I - <<'EOF'\np='a.py'; s=open(p).read()\nEOF", 'node -e "console.log(1)"'])
    assert.equal(commandHead(c), '', c);
  assert.equal(commandHead('cd x && cat a.md && python -I tools/build.py --part 1'), 'python build.py');
  assert.equal(commandHead("python - <<'EOF'\np='assemble.py'\nEOF\npython -I tools/assemble.py --part 2"), 'python assemble.py', 'the heredoc body is not read as a command');
  assert.equal(commandHead('D=out/1; mkdir -p $D && ffmpeg -i a.mp4 $D/a.jpg'), 'ffmpeg');
  assert.equal(commandHead('python -m unittest discover -s tests'), 'python -m unittest');
  assert.equal(commandHead("ego-browser nodejs <<'EOF' 2>&1 | grep -v notice\nconst t = 1;\nEOF"), 'ego-browser nodejs');
});

test('one call\'s unit: a file (in parts or again), a shell step with the heredoc it is fed', () => {
  assert.equal(callUnit('Read', { file_path: 'C:\\Src\\a.ts', offset: 100 }), 'c:/src/a.ts');
  assert.equal(callUnit('Bash', { command: 'cd x; npm  test' }), callUnit('Bash', { command: 'npm test' }), 'the same test run');
  const a = callUnit('Bash', { command: "ego-browser nodejs <<'EOF'\nawait page.click('@1');\nEOF" });
  const b = callUnit('Bash', { command: "ego-browser nodejs <<'EOF'\nawait page.click('@2');\nEOF" });
  assert.notEqual(a, b, 'two browser scripts are two steps');
  assert.equal(callUnit('WebFetch', { url: 'https://x.example.com/1' }), '');
});

test('a call kind: the tool and the kind of target; edits, searches and the secretary\'s memory are not counted', () => {
  assert.equal(callKind('PowerShell', { command: 'Rename-Item a.jpg b.jpg' }), 'PowerShell: rename-item');
  assert.equal(callKind('Read', { file_path: 'C:\\mail\\2026-10\\001.eml' }), 'Read: c:/mail/2026-10/');
  assert.equal(callKind('WebFetch', { url: 'https://mail.example.com/m/3' }), 'WebFetch: mail.example.com');
  assert.equal(callKind('mcp__claude-in-chrome__get_page_text', {}), 'mcp__claude-in-chrome__get_page_text');
  for (const name of ['Edit', 'Grep', 'Glob', 'Agent', 'Skill', 'WebSearch', 'mcp__secretary__recall', 'TaskUpdate', 'TaskCreate', 'ListAgents']) assert.equal(callKind(name, {}), '', name);
  assert.equal(callKind('PowerShell', { command: 'Get-Content a.txt' }), '', 'the shell\'s Read');
  assert.equal(callKind('WebFetch', { url: 'https://www.bing.com/search?q=tavily+pricing' }), '', 'a search page is a search');
  assert.equal(callKind('WebFetch', { url: 'https://www.google.com/' }), 'WebFetch: www.google.com');
});

/** A transcript in Claude Code's JSONL shape, written line by line as a session would. */
class Transcript {
  readonly file: string;
  private n = 0;
  constructor(dir: string) {
    this.file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(this.file, '');
  }
  private add(o: object): void {
    fs.appendFileSync(this.file, `${JSON.stringify({ uuid: `u${++this.n}`, ...o })}\n`);
  }
  prompt(text: string): void {
    this.add({ type: 'user', message: { content: text } });
  }
  call(name: string, input: Record<string, unknown>): void {
    const id = `toolu_${this.n + 1}`;
    this.add({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    this.add({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }
}

test('counted within a turn: told once at the limit, again only in a new turn; other kinds count apart', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  const hook = (limit = 3) => runRepeatHook({ session_id: 's-1', transcript_path: t.file }, { limit, dir: path.join(dir, 'state') });
  t.prompt('메일 공부해 줘');
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/1' });
  assert.equal(hook(), '');
  t.call('Read', { file_path: 'C:/notes/a.md' });
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/2' });
  assert.equal(hook(), '');
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/3' });
  const note = hook();
  assert.match(note, /^\[되풀이 점검\] 같은 조작\(Bash: ego-browser open\)을 이 턴에서 3번 되풀이 중\. 도구·스크립트로 한꺼번에 처리할 수 있는지 따져 보고, 남은 건수와 예상 시간/);
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/4' });
  assert.equal(hook(), '', 'once per kind in a turn');
  // A tool result is not a new turn; a new prompt is.
  t.prompt('계속해');
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/5' });
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/6' });
  assert.equal(hook(), '');
  t.call('Bash', { command: 'ego-browser open https://mail.example.com/7' });
  assert.match(hook(), /3번 되풀이 중/);
  // Limit 0 is off.
  assert.equal(runRepeatHook({ session_id: 's-2', transcript_path: t.file }, { limit: 0, dir: path.join(dir, 'state') }), '');
});

test('work any task repeats is not counted (from the 2026-11-07 transcript review); a step done item by item still is', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  const hook = () => runRepeatHook({ session_id: 's-noise', transcript_path: t.file }, { limit: 10, dir: path.join(dir, 'state') });
  t.prompt('이 기능 고쳐 줘');
  // One file read in parts, four code files read again and again, the same test run after each fix.
  for (let i = 0; i < 12; i++) t.call('Read', { file_path: 'C:\\work\\data\\products.json', offset: i * 200, limit: 200 });
  for (let i = 0; i < 12; i++) t.call('Read', { file_path: `C:\\work\\src\\f${i % 4}.ts` });
  for (let i = 0; i < 12; i++) t.call('Bash', { command: 'cd /c/work && npm test 2>&1 | tail -5' });
  for (let i = 0; i < 12; i++) t.call('Write', { file_path: 'C:\\work\\notes\\PROGRESS.md', content: `${i}` });
  // Looking around with the shell, inline edits, the progress list, searches fetched as pages.
  for (let i = 0; i < 12; i++) t.call('Bash', { command: `grep -n "x${i}" src/a.ts | head` });
  for (let i = 0; i < 12; i++) t.call('Bash', { command: `cat >> PROGRESS.md <<'EOF'\n- ${i} 끝\nEOF` });
  for (let i = 0; i < 12; i++) t.call('Bash', { command: `python -I - <<'EOF'\np='a.py'; s=open(p).read().replace('${i}','x')\nEOF` });
  for (let i = 0; i < 12; i++) t.call('TaskUpdate', { taskId: String(i), status: 'completed' });
  for (let i = 0; i < 12; i++) t.call('WebFetch', { url: `https://www.bing.com/search?q=api+pricing+${i}` });
  assert.equal(hook(), '');
  // Item by item: mails read one by one, a browser script per item, one script run per item.
  t.prompt('메일 100통 정리해 줘');
  for (let i = 0; i < 10; i++) t.call('Read', { file_path: `C:\\mail\\2026-10\\${i}.eml` });
  for (let i = 0; i < 10; i++) t.call('Bash', { command: `ego-browser nodejs <<'EOF'\nawait page.goto('https://mail.example.com/${i}');\nEOF` });
  for (let i = 0; i < 10; i++) t.call('PowerShell', { command: `python -I tools\\export.py --id ${i}` });
  const note = hook();
  assert.match(note, /Read: c:\/mail\/2026-10\/\)을 이 턴에서 10번/);
  assert.match(note, /Bash: ego-browser nodejs\)을 이 턴에서 10번/);
  assert.match(note, /PowerShell: python export\.py\)을 이 턴에서 10번/);
});

test('images read to be looked at are not counted (decided 2026-11-07); mails and documents read one by one still are', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  const hook = () => runRepeatHook({ session_id: 's-img', transcript_path: t.file }, { limit: 10, dir: path.join(dir, 'state') });
  assert.equal(callKind('Read', { file_path: 'C:\\shots\\a.PNG' }), '');
  assert.equal(callKind('Write', { file_path: 'C:\\shots\\a.png' }), 'Write: c:/shots/');
  t.prompt('시안 확인해 줘');
  const ext = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  for (let i = 0; i < 12; i++) t.call('Read', { file_path: `C:\\work\\shots\\sheet-${i}.${ext[i % ext.length]}` });
  assert.equal(hook(), '');
  for (let i = 0; i < 10; i++) t.call('Read', { file_path: `C:\\work\\shots\\${i}.${i % 2 ? 'eml' : 'md'}` });
  assert.match(hook(), /Read: c:\/work\/shots\/\)을 이 턴에서 10번/);
});

test('a session first seen mid-turn counts what its transcript already holds; a line still being written waits', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  t.prompt('사진 이름 바꿔 줘');
  for (let i = 0; i < 4; i++) t.call('PowerShell', { command: `Rename-Item p${i}.jpg q${i}.jpg` });
  // Half a line at the end (the app is still writing it).
  fs.appendFileSync(t.file, '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"PowerShell","input":{"command":"Rename-Item p9');
  const note = runRepeatHook({ session_id: 's', transcript_path: t.file }, { limit: 4, dir: path.join(dir, 'state') });
  assert.match(note, /PowerShell: rename-item\)을 이 턴에서 4번/);
});

test('the limit: 10 by default, from scripts/guards.local.json repeatLimit, 0 to turn it off', () => {
  assert.equal(DEFAULT_REPEAT_LIMIT, 10);
  const root = tempDir();
  const withGuards = (enabled: boolean) => JSON.stringify({ features: readFeatures(PROJECT_ROOT)!.map((f) => (f.id === 'guards' ? { ...f, enabled } : f)) });
  fs.writeFileSync(path.join(root, 'features.json'), withGuards(true));
  fs.mkdirSync(path.join(root, 'scripts'));
  const local = path.join(root, 'scripts', 'guards.local.json');
  // A temp copy's local file is read (only this copy's own is hidden from tests, test/env.ts).
  const read = () => repeatLimit(root);
  assert.equal(read(), 10);
  fs.writeFileSync(local, JSON.stringify({ repeatLimit: 15 }));
  assert.equal(read(), 15);
  fs.writeFileSync(local, JSON.stringify({ repeatLimit: 0 }));
  assert.equal(read(), 0);
  fs.writeFileSync(local, JSON.stringify({ repeatLimit: 'many' }));
  assert.equal(read(), 10);
  fs.writeFileSync(path.join(root, 'features.json'), withGuards(false));
  assert.equal(read(), 0, 'off with the feature');
});

test('the hook as Claude Code runs it: JSON on stdin, a PostToolUse note on stdout at the tenth call', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  t.prompt('페이지 열어 읽어 줘');
  const run = () =>
    execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'guards', 'repeat-hook.ts')], {
      input: JSON.stringify({ session_id: 'hook-run', transcript_path: t.file, hook_event_name: 'PostToolUse', tool_name: 'WebFetch' }),
      encoding: 'utf8',
    });
  for (let i = 0; i < 9; i++) t.call('WebFetch', { url: `https://shop.example.com/item/${i}` });
  assert.equal(run(), '');
  t.call('WebFetch', { url: 'https://shop.example.com/item/9' });
  const out = JSON.parse(run()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /같은 조작\(WebFetch: shop\.example\.com\)을 이 턴에서 10번/);
  assert.equal(execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'guards', 'repeat-hook.ts')], { input: 'not json', encoding: 'utf8' }), '');
});

test('the hook is put in for the secretary, work sessions and run-jobs', { skip: process.platform !== 'win32' }, () => {
  const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf8'));
  const post = settings.hooks.PostToolUse.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
  assert.ok(post.some((c: string) => c.includes('src/guards/repeat-hook.ts')));
  const common = path.join(PROJECT_ROOT, 'scripts', 'lib', 'common.ps1');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${common}'; [pscustomobject]@{ PostToolUse = @(Get-RepeatHook) } | ConvertTo-Json -Depth 6 -Compress`], { encoding: 'utf8' });
  const hooks = JSON.parse(out).PostToolUse;
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].matcher, 'Bash|PowerShell|Read|Write|WebFetch|mcp__.*');
  assert.ok(hooks[0].hooks[0].command.endsWith(`${path.join('src', 'guards', 'repeat-hook.ts')}"`));
  for (const f of ['scripts/worker/worker-lib.ps1', 'scripts/run-job/run-job.ps1']) assert.match(fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf8'), /Get-RepeatHook/, f);
});
