// 사용량 일시 정지 장치를 사용자 설정(~/.claude/settings.json)에 등록한다: 상태줄(usage-statusline.mjs)과
// 전역 PreToolUse 훅(usage-guard.mjs). 비서 폴더뿐 아니라 업무 세션에도 걸려야 해서 프로젝트가 아닌 사용자 설정에 넣는다.
// 둘 다 비서 폴더의 고정 진입점(bin/, src/core/paths.ts ENTRY_POINTS)를 부르게 적어, 스크립트를 옮겨도 다시 등록하지 않아도 된다.
// 이미 이 진입점으로 등록돼 있으면 건너뛰고, 이 비서의 옛 경로(이 폴더 안의 옛 위치, 또는 비서가 없어진 폴더 = 이 비서가 옮겨 오기 전 위치)로
// 등록된 것은 이 진입점으로 고치고, 다른 상태줄이 있으면 덮어쓰지 않는다.
// 한 PC에 비서가 여럿이면 다른 비서 폴더(지금도 비서가 있는 폴더)를 부르는 상태줄·훅은 그 비서 것으로 보고 건드리지 않는다
// (사용량 기록은 PC에 하나라 그 비서 것을 함께 쓴다. 판단: src/setup/other-secretaries.ts). 실행: node scripts/usage/install-usage-guard.mjs
// 두 번째 구독 계정의 설정 폴더에도 걸려면 CLAUDE_CONFIG_DIR=<그 폴더>로 한 번 더 실행한다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookKind } from '../../src/setup/other-secretaries.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(root, 'bin').replaceAll('\\', '/');
const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

let settings = {};
if (existsSync(file)) settings = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
// 바뀐 것이 있을 때만 쓰고 그때만 사본(.bak)을 남긴다: 돌릴 때마다 사본을 덮어쓰면 낡은 경로가 든 사본이 남는다(2026-11-10).
const before = JSON.stringify(settings);

const statusCmd = `node "${bin}/usage-statusline.mjs"`;
const guardCmd = `node "${bin}/usage-guard.mjs"`;
const notes = [];
const otherNote = (k) => `다른 비서(${k.folder})${k.kind === 'other-gone' ? '의 없는 파일을 부르지만 그 비서 것이라' : ' 것이라'} 건드리지 않음${k.kind === 'other-gone' ? '(그 비서 폴더에서 이 스크립트를 다시 돌린다)' : '(사용량 기록은 PC에 하나라 함께 쓴다)'}`;

const status = hookKind(settings.statusLine?.command, 'usage-statusline.mjs', root);
if (status.kind === 'none') {
  settings.statusLine = { type: 'command', command: statusCmd };
  notes.push('상태줄 등록');
} else if (status.kind === 'this' && settings.statusLine.command === statusCmd) {
  notes.push('상태줄은 이미 등록돼 있음');
} else if (status.kind === 'this' || status.kind === 'old') {
  notes.push(`상태줄을 진입점으로 고침 (전: ${settings.statusLine.command})`);
  settings.statusLine.command = statusCmd;
} else if (status.kind === 'foreign') {
  notes.push(`다른 상태줄이 있어 건드리지 않음 (사용량 기록이 안 되므로 정지 장치도 동작하지 않음): ${settings.statusLine.command}`);
} else {
  notes.push(`상태줄: ${otherNote(status)}: ${settings.statusLine.command}`);
}

settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
const guards = settings.hooks.PreToolUse.flatMap((g) => g.hooks ?? []).map((h) => ({ h, k: hookKind(h.command, 'usage-guard.mjs', root) }));
const mine = guards.filter((g) => g.k.kind === 'this' || g.k.kind === 'old');
const others = guards.filter((g) => g.k.kind === 'other' || g.k.kind === 'other-gone');
if (mine.some((g) => g.h.command === guardCmd)) {
  notes.push('정지 훅은 이미 등록돼 있음');
} else if (mine.length) {
  for (const { h } of mine) {
    notes.push(`정지 훅을 진입점으로 고침 (전: ${h.command})`);
    h.command = guardCmd;
  }
} else if (others.length) {
  for (const { h, k } of others) notes.push(`정지 훅: ${otherNote(k)}: ${h.command}`);
} else {
  settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: guardCmd, timeout: 5 }] });
  notes.push('정지 훅 등록');
}

if (JSON.stringify(settings) === before) {
  notes.push('바뀐 것이 없어 설정 파일을 쓰지 않음');
} else {
  if (existsSync(file)) copyFileSync(file, file + '.bak');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
}
console.log(`${file}\n- ${notes.join('\n- ')}`);
