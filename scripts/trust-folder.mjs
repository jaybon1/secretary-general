// 공간 폴더를 Claude Code 설정(.claude.json)에 '신뢰함'으로 적는다. start-worker.ps1이 업무 세션을 띄우기 전에 부른다.
// 백그라운드 세션(claude --bg)은 상위 폴더 신뢰를 이어받지 않아, 공간 폴더마다 승인 창을 눌러야 했다.
// 상위 폴더 중 하나가 이미 신뢰돼 있을 때만 적는다. 설정 폴더: CLAUDE_CONFIG_DIR, 없으면 홈.
//
// 예: node scripts/trust-folder.mjs <공간 폴더>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const key = (p) => resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
const folder = key(process.argv[2]);
const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
if (!existsSync(file)) { console.log(`신뢰: 설정 파일이 없어요 (${file})`); process.exit(0); }

const config = JSON.parse(readFileSync(file, 'utf8'));
const projects = (config.projects ??= {});
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const entry = Object.entries(projects).find(([k]) => same(k, folder));
if (entry?.[1].hasTrustDialogAccepted) process.exit(0);

const parent = Object.entries(projects).find(([k, v]) => v.hasTrustDialogAccepted && folder.toLowerCase().startsWith(k.toLowerCase() + '/'));
if (!parent) { console.log(`신뢰: 신뢰된 상위 폴더가 없어 적지 않았어요 (${folder})`); process.exit(0); }

if (entry) entry[1].hasTrustDialogAccepted = true;
else projects[folder] = { allowedTools: [], hasTrustDialogAccepted: true };
writeFileSync(file, JSON.stringify(config, null, 2));
console.log(`신뢰: ${folder} (상위 ${parent[0]} 기준)`);
