// 비서 업데이트 도우미(.claude/skills/update/SKILL.md가 부른다). AI를 부르지 않고 git과 Node 기본 기능만 쓴다.
// 사용자 폴더(zip을 풀어 쓰며 고쳤을 수 있는 비서 폴더)를 받은 저장소(git clone, tag v1, v2, …)의 최신 tag로 올린다.
// 사용자가 고친 파일은 기준 tag(사용자가 받았던 버전)와 비교해 찾고, git merge-file로 3방향 합치기를 한다.
// 기억 DB·모델·node_modules·*.local.*·키·백업·.git은 읽지도 고치지도 않는다.
//
//   node <받은 저장소>/scripts/update.mjs backup  --user <비서 폴더>
//   node <받은 저장소>/scripts/update.mjs detect  --user <비서 폴더> --repo <받은 저장소>
//   node <받은 저장소>/scripts/update.mjs plan    --user <비서 폴더> --repo <받은 저장소> --base <tag>
//   node <받은 저장소>/scripts/update.mjs apply   --user <비서 폴더> --repo <받은 저장소> --base <tag> --work <백업 폴더>
//   node <받은 저장소>/scripts/update.mjs resolve --user <비서 폴더> --work <백업 폴더> --file <경로> --take mine|new|edited
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Never read or written by an update: personal data, downloads, local settings, keys, backups. */
export const PROTECTED = /(^|\/)(node_modules|backups|models|\.git|keys)(\/|$)|\.db(-wal|-shm|-journal)?$|\.db\.|\.embedder|\.local\.|\.env$/;
/** Left out of the folder copy: the database has its own backup, the rest can be downloaded again. */
const NOT_COPIED = /(^|\/)(node_modules|backups|models|\.git)(\/|$)|\.db(-wal|-shm|-journal)?$/;
const BOM = '﻿';

/** Content for comparing: no BOM, LF line ends. Editors and zip tools change these without changing the file. */
export function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/**
 * What to do with one file. Each side is the normalized content, or undefined when the file is not there.
 * base = the version the user installed, user = the user's folder now, theirs = the newest version.
 */
export function classify(base, user, theirs) {
  if (user === theirs) return 'same';
  if (base === undefined) return user === undefined ? 'add' : 'ask-add';
  if (theirs === undefined) return user === base ? 'delete' : 'ask-delete';
  if (user === undefined) return theirs === base ? 'same' : 'ask-missing';
  if (user === base) return 'replace';
  if (theirs === base) return 'keep';
  return 'merge';
}

/**
 * Which version the user's files match best. versions: [{ tag, files: Map(path → normalized) }] oldest first;
 * userFile(path) → normalized or undefined. A clear winner leads by 5 points and matches at least half.
 */
export function detectVersion(versions, userFile) {
  const rates = versions.map(({ tag, files }) => {
    let matched = 0;
    for (const [p, text] of files) if (userFile(p) === text) matched++;
    return { tag, matched, total: files.size, rate: files.size ? matched / files.size : 0 };
  });
  // Best rate first; on a tie the newer version (it contains the older one's unchanged files too).
  const order = rates.map((r, i) => ({ ...r, i })).sort((a, b) => b.rate - a.rate || b.i - a.i);
  const [first, second] = order;
  const clear = !!first && first.rate >= 0.5 && (!second || first.rate - second.rate >= 0.05);
  return { best: first?.tag, clear, rates };
}

// ---- git -------------------------------------------------------------------------------

function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 1 << 28 });
}

export function listTags(repo) {
  return git(repo, ['tag', '--list', 'v*', '--sort=v:refname']).toString().split('\n').map((s) => s.trim()).filter(Boolean);
}

/** path → blob sha for a tag. */
function tree(repo, tag) {
  const out = git(repo, ['ls-tree', '-r', '-z', tag]).toString();
  const map = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const [meta, p] = entry.split('\t');
    const [, type, sha] = meta.split(' ');
    if (type === 'blob' && !PROTECTED.test(p)) map.set(p, sha);
  }
  return map;
}

/** Raw bytes of many blobs in one git process. */
function blobs(repo, shas) {
  const unique = [...new Set(shas)];
  const out = new Map();
  if (!unique.length) return out;
  const buf = git(repo, ['cat-file', '--batch'], unique.join('\n') + '\n');
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const [sha, , size] = buf.subarray(pos, nl).toString().split(' ');
    const start = nl + 1;
    out.set(sha, buf.subarray(start, start + Number(size)));
    pos = start + Number(size) + 1;
  }
  return out;
}

/** Each tag's files as path → raw bytes. */
function versionFiles(repo, tags) {
  const trees = tags.map((t) => tree(repo, t));
  const raw = blobs(repo, trees.flatMap((t) => [...t.values()]));
  return trees.map((t) => new Map([...t].map(([p, sha]) => [p, raw.get(sha)])));
}

// ---- user folder -----------------------------------------------------------------------

function userRaw(userDir, p) {
  const f = path.join(userDir, ...p.split('/'));
  return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : undefined;
}

const text = (b) => (b === undefined ? undefined : normalize(b.toString('utf8')));
const isBinary = (b) => b !== undefined && b.includes(0);

/** Writes merged or chosen text back in the user's style: CRLF if the user's file had it, BOM if either side had one. */
export function restyle(textLf, userRawText, theirsRawText) {
  const crlf = (userRawText ?? theirsRawText ?? '').includes('\r\n');
  const bom = [userRawText, theirsRawText].some((s) => s?.startsWith(BOM));
  return (bom ? BOM : '') + (crlf ? textLf.replace(/\n/g, '\r\n') : textLf);
}

function writeFile(userDir, p, data) {
  const f = path.join(userDir, ...p.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

/**
 * git merge-file on normalized texts; { text, conflicts } with 내 것 / 새 버전 markers.
 * favor 'ours' / 'theirs' settles only the clashing parts that way; the parts that merged cleanly stay merged.
 */
export function merge3(base, user, theirs, favor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-merge-'));
  try {
    const [b, u, t] = ['base', 'user', 'theirs'].map((n) => path.join(dir, n));
    fs.writeFileSync(b, base);
    fs.writeFileSync(u, user);
    fs.writeFileSync(t, theirs);
    try {
      const out = execFileSync('git', ['merge-file', '-p', ...(favor ? [`--${favor}`] : []), '-L', '내 것', '-L', '기준', '-L', '새 버전', u, b, t], { maxBuffer: 1 << 28 });
      return { text: out.toString('utf8'), conflicts: 0 };
    } catch (err) {
      // Exit code = number of conflicts (output still on stdout); negative means it failed.
      if (typeof err.status === 'number' && err.status > 0 && err.stdout) return { text: err.stdout.toString('utf8'), conflicts: err.status };
      throw err;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- commands --------------------------------------------------------------------------

function args() {
  const a = process.argv.slice(3);
  const get = (k) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { user: get('user'), repo: get('repo'), base: get('base'), work: get('work'), file: get('file'), take: get('take') };
}

function need(o, ...keys) {
  for (const k of keys) if (!o[k]) throw new Error(`--${k} 가 필요해요`);
  if (o.user && !fs.existsSync(path.join(o.user, 'package.json'))) throw new Error(`비서 폴더가 아니에요(package.json 없음): ${o.user}`);
}

const stamp = () => {
  const d = new Date(Date.now() + 9 * 3600e3); // KST, so the folder name matches the user's clock
  return d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
};

function copyTree(from, to, rel = '') {
  let n = 0;
  for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (NOT_COPIED.test(r)) continue;
    if (e.isDirectory()) n += copyTree(from, to, r);
    else if (e.isFile()) {
      fs.mkdirSync(path.join(to, rel), { recursive: true });
      fs.copyFileSync(path.join(from, r), path.join(to, r));
      n++;
    }
  }
  return n;
}

function cmdBackup(o) {
  need(o, 'user');
  const work = path.join(o.user, 'backups', `update-${stamp()}`);
  const n = copyTree(o.user, path.join(work, 'files'));
  console.log(`백업 사본: ${work}\\files (파일 ${n}개, DB·모델·node_modules·backups 제외)`);
  console.log(`WORK=${work}`);
}

function load(o) {
  const tags = listTags(o.repo);
  if (!tags.length) throw new Error(`받은 저장소에 v로 시작하는 tag가 없어요: ${o.repo}`);
  return { tags, latest: tags[tags.length - 1] };
}

function cmdDetect(o) {
  need(o, 'user', 'repo');
  const { tags, latest } = load(o);
  const files = versionFiles(o.repo, tags);
  const versions = tags.map((tag, i) => ({ tag, files: new Map([...files[i]].map(([p, b]) => [p, text(b)])) }));
  const cache = new Map();
  const userFile = (p) => (cache.has(p) ? cache.get(p) : (cache.set(p, text(userRaw(o.user, p))), cache.get(p)));
  const { best, clear, rates } = detectVersion(versions, userFile);
  const version = text(userRaw(o.user, 'VERSION'))?.trim();
  console.log(`최신: ${latest}`);
  console.log(`VERSION 파일: ${version ?? '(없음)'}`);
  for (const r of rates) console.log(`- ${r.tag}: ${r.matched}/${r.total} 파일 일치 (${Math.round(r.rate * 100)}%)`);
  if (version && tags.includes(version)) console.log(`판별: ${version} (VERSION 파일)`);
  else console.log(`판별: ${best} (일치율 기준, ${clear ? '분명함' : '애매함 - 사용자에게 물어볼 것'})`);
  console.log(`BASE=${version && tags.includes(version) ? version : best}`);
  console.log(`CLEAR=${(version && tags.includes(version)) || clear ? 'yes' : 'no'}`);
}

/** Every file of the base and newest versions with what to do about it. */
function makePlan(o) {
  const { tags, latest } = load(o);
  if (!tags.includes(o.base)) throw new Error(`없는 tag예요: ${o.base} (있는 것: ${tags.join(', ')})`);
  const [baseFiles, newFiles] = versionFiles(o.repo, [o.base, latest]);
  const paths = [...new Set([...baseFiles.keys(), ...newFiles.keys()])].sort();
  const items = paths.map((p) => {
    const b = baseFiles.get(p);
    const u = userRaw(o.user, p);
    const t = newFiles.get(p);
    let action = classify(text(b), text(u), text(t));
    if (action === 'merge' && [b, u, t].some(isBinary)) action = 'ask-binary';
    return { path: p, action, base: b, user: u, theirs: t };
  });
  return { latest, items };
}

const LABEL = {
  replace: '새 버전으로 바꿈(사용자가 안 고친 파일)',
  add: '새 파일 추가',
  delete: '지움(새 버전에서 없어졌고 사용자가 안 고침)',
  keep: '사용자 것 그대로(새 버전에서 안 바뀜)',
  merge: '3방향 합치기(사용자도 새 버전도 고침)',
  'ask-add': '물어볼 것: 새 버전이 추가한 파일과 같은 이름의 사용자 파일이 있음',
  'ask-delete': '물어볼 것: 새 버전에서 지운 파일을 사용자가 고쳤음',
  'ask-missing': '물어볼 것: 사용자가 지운 파일이 새 버전에서 바뀜',
  'ask-binary': '물어볼 것: 둘 다 고친 바이너리 파일',
};

function printPlan(latest, base, items) {
  const counts = {};
  for (const i of items) counts[i.action] = (counts[i.action] ?? 0) + 1;
  console.log(`기준 ${base} → 최신 ${latest}`);
  if (items.every((i) => i.action === 'same' || i.action === 'keep')) {
    console.log('이미 최신이에요(바꿀 파일 없음).');
    return;
  }
  for (const [action, label] of Object.entries(LABEL)) {
    const list = items.filter((i) => i.action === action);
    if (!list.length) continue;
    console.log(`${label}: ${list.length}개`);
    for (const i of list) console.log(`  - ${i.path}`);
  }
  console.log(`변경 없음: ${counts.same ?? 0}개`);
}

function cmdPlan(o) {
  need(o, 'user', 'repo', 'base');
  const { latest, items } = makePlan(o);
  printPlan(latest, o.base, items);
}

function cmdApply(o) {
  need(o, 'user', 'repo', 'base', 'work');
  if (!fs.existsSync(path.join(o.work, 'files'))) throw new Error(`백업 사본이 없어요. backup을 먼저 돌리세요: ${o.work}`);
  const { latest, items } = makePlan(o);
  printPlan(latest, o.base, items);
  const pkgBefore = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  const results = [];
  const keep = (dir, p, data) => {
    const f = path.join(o.work, dir, ...p.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    return f;
  };
  for (const i of items) {
    const r = { path: i.path, action: i.action, status: 'done' };
    const style = (t) => restyle(t, i.user?.toString('utf8'), i.theirs?.toString('utf8'));
    if (i.action === 'replace' || i.action === 'add') writeFile(o.user, i.path, i.theirs);
    else if (i.action === 'delete') fs.rmSync(path.join(o.user, ...i.path.split('/')));
    else if (i.action === 'merge') {
      const [b, u, t] = [text(i.base), text(i.user), text(i.theirs)];
      const m = merge3(b, u, t);
      if (m.conflicts === 0) writeFile(o.user, i.path, style(m.text));
      else {
        // The user's file stays as it was until the user decides. Waiting in the work folder: the marked-up merge,
        // and the merge with the clashing parts settled each way (resolve --take mine / new); the parts that
        // merged cleanly are in both, so "mine" still gets the rest of the new version.
        const side = keep('conflicts', i.path, style(m.text));
        keep('mine', i.path, style(merge3(b, u, t, 'ours').text));
        keep('new', i.path, style(merge3(b, u, t, 'theirs').text));
        Object.assign(r, { status: 'conflict', conflicts: m.conflicts, side });
      }
    } else if (i.action.startsWith('ask-')) {
      r.status = 'ask';
      // Whole-file choices: mine = the user's file as it is, new = the new version's file (none: delete).
      if (i.theirs !== undefined) keep('new', i.path, i.theirs);
    } else r.status = 'none';
    results.push(r);
  }
  const pkgAfter = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  const state = { base: o.base, latest, packageChanged: pkgBefore.some((x, k) => x !== pkgAfter[k]), results };
  fs.writeFileSync(path.join(o.work, 'update.json'), JSON.stringify(state, null, 1));
  const open = results.filter((r) => r.status === 'conflict' || r.status === 'ask');
  console.log('');
  console.log(`적용함: ${results.filter((r) => r.status === 'done').length}개`);
  console.log(`package.json 바뀜: ${state.packageChanged ? '예 (npm install 필요)' : '아니요'}`);
  if (!open.length) console.log('남은 부딪힘: 없음');
  else {
    console.log(`남은 부딪힘: ${open.length}개 (사용자에게 물어볼 것, 그동안 사용자 파일은 그대로)`);
    for (const r of open) console.log(`  - ${r.path} · ${LABEL[r.action]}${r.side ? ` · 합친 안: ${r.side} (부딪힌 곳 ${r.conflicts}군데)` : ''}`);
  }
}

function cmdResolve(o) {
  need(o, 'user', 'work', 'file', 'take');
  const stateFile = path.join(o.work, 'update.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const r = state.results.find((x) => x.path === o.file);
  if (!r || (r.status !== 'conflict' && r.status !== 'ask')) throw new Error(`남은 부딪힘이 아니에요: ${o.file}`);
  const newCopy = path.join(o.work, 'new', ...o.file.split('/'));
  const mineCopy = path.join(o.work, 'mine', ...o.file.split('/'));
  if (o.take === 'mine') {
    // A clash inside a merge: the user's side in the clashing parts, the rest merged. Otherwise the user's file stays.
    if (r.status === 'conflict') writeFile(o.user, o.file, fs.readFileSync(mineCopy));
  } else if (o.take === 'new') {
    if (fs.existsSync(newCopy)) writeFile(o.user, o.file, fs.readFileSync(newCopy));
    else fs.rmSync(path.join(o.user, ...o.file.split('/')), { force: true });
  } else if (o.take === 'edited') {
    if (!r.side) throw new Error('합친 안이 없는 항목이에요. mine 또는 new로 고르세요.');
    const edited = fs.readFileSync(r.side, 'utf8');
    // Only the labelled markers merge3 writes, so a Markdown "=======" underline in the user's text is not mistaken for one.
    if (/^(<<<<<<< 내 것|>>>>>>> 새 버전)\r?$/m.test(edited)) throw new Error(`합친 안에 표시(<<<<<<< 등)가 남아 있어요: ${r.side}`);
    writeFile(o.user, o.file, edited);
  } else throw new Error('--take 는 mine, new, edited 중 하나예요');
  Object.assign(r, { status: 'resolved', take: o.take });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  const left = state.results.filter((x) => x.status === 'conflict' || x.status === 'ask').map((x) => x.path);
  console.log(`정리함: ${o.file} → ${o.take}. 남은 부딪힘: ${left.length ? left.join(', ') : '없음'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmds = { backup: cmdBackup, detect: cmdDetect, plan: cmdPlan, apply: cmdApply, resolve: cmdResolve };
  const cmd = cmds[process.argv[2]];
  try {
    if (!cmd) throw new Error('usage: node scripts/update.mjs backup|detect|plan|apply|resolve --user <비서 폴더> [--repo <받은 저장소>] [--base <tag>] [--work <백업 폴더>]');
    const o = args();
    for (const k of ['user', 'repo', 'work']) if (o[k]) o[k] = path.resolve(o[k]);
    // Paths in the plan are repo-style (src/recall.ts); PowerShell users may type src\recall.ts.
    if (o.file) o.file = o.file.replace(/\\/g, '/').replace(/^\.\//, '');
    cmd(o);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    process.exitCode = 1;
  }
}
