// 사용량 일시 정지 장치를 사용자 설정(~/.claude/settings.json)에 등록한다: 상태줄(usage-statusline.mjs)과
// 전역 PreToolUse 훅(usage-guard.mjs). 비서 폴더뿐 아니라 업무 세션에도 걸려야 해서 프로젝트가 아닌 사용자 설정에 넣는다.
// 이미 등록돼 있으면 건너뛰고, 다른 상태줄이 있으면 덮어쓰지 않는다. 실행: node scripts/install-usage-guard.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

let settings = {};
if (existsSync(file)) {
  settings = JSON.parse(readFileSync(file, 'utf8'));
  copyFileSync(file, file + '.bak');
}

const statusCmd = `node "${scripts}/usage-statusline.mjs"`;
const guardCmd = `node "${scripts}/usage-guard.mjs"`;
const notes = [];

if (!settings.statusLine) {
  settings.statusLine = { type: 'command', command: statusCmd };
  notes.push('상태줄 등록');
} else if (settings.statusLine.command?.includes('usage-statusline.mjs')) {
  notes.push('상태줄은 이미 등록돼 있음');
} else {
  notes.push(`다른 상태줄이 있어 건드리지 않음 (사용량 기록이 안 되므로 정지 장치도 동작하지 않음): ${settings.statusLine.command}`);
}

settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
const registered = settings.hooks.PreToolUse.some((g) => g.hooks?.some((h) => h.command?.includes('usage-guard.mjs')));
if (registered) {
  notes.push('정지 훅은 이미 등록돼 있음');
} else {
  settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: guardCmd, timeout: 5 }] });
  notes.push('정지 훅 등록');
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(settings, null, 2));
console.log(`${file}\n- ${notes.join('\n- ')}`);
