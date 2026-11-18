// The repeat reminder (feature 'mistake-guards', src/mistake-guards/repeat-hook.ts): what counts as one kind of call, counting within a
// turn from a transcript read bit by bit, telling once per kind and turn, and the hook as Claude Code runs it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';

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

test('the hook as Claude Code runs it: JSON on stdin, a PostToolUse note on stdout at the tenth call', () => {
  const dir = tempDir();
  const t = new Transcript(dir);
  t.prompt('페이지 열어 읽어 줘');
  const run = () =>
    execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'mistake-guards', 'repeat-hook.ts')], {
      input: JSON.stringify({ session_id: 'hook-run', transcript_path: t.file, hook_event_name: 'PostToolUse', tool_name: 'WebFetch' }),
      encoding: 'utf8',
    });
  for (let i = 0; i < 9; i++) t.call('WebFetch', { url: `https://shop.example.com/item/${i}` });
  assert.equal(run(), '');
  t.call('WebFetch', { url: 'https://shop.example.com/item/9' });
  const out = JSON.parse(run()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /같은 조작\(WebFetch: shop\.example\.com\)을 이 턴에서 10번/);
  assert.equal(execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'src', 'mistake-guards', 'repeat-hook.ts')], { input: 'not json', encoding: 'utf8' }), '');
});
