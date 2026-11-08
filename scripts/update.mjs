// @ts-check
// 비서 업데이트 도우미(.agents/skills/update/SKILL.md, 공개하지 않은 v8 시험판은 skills/update/SKILL.md, v7은 .claude/skills/update/SKILL.md가 부른다). AI를 부르지 않고 git과 Node 기본 기능만 쓴다.
// 사용자 폴더(zip을 풀어 쓰며 고쳤을 수 있는 비서 폴더)를 받은 저장소(git clone, tag v7, v8, v0.9.0, …)의 최신 tag로 올린다(v7부터, 받았던 버전은 VERSION 파일로 안다).
// 버전 번호: v8까지는 tag가 숫자 하나(vN)였고 0.N.0으로 읽는다(v8 = 0.8.0). 그 뒤는 0.x 세 자리(v0.9.0, semver: 끝자리 고침, 가운데 기능 추가,
// 앞자리 사용자가 손봐야 하는 변경)이고, tag 순서는 git의 이름 정렬이 아니라 이 번호로 센다(parseVersion, sortTags).
// 사용자가 고친 파일은 기준 tag(사용자가 받았던 버전)와 비교해 찾고, v8부터는 사용자 폴더의 배포판 파일 목록(release-files.json,
// 받았던 판의 파일마다 내용 해시)으로도 본다: 해시가 그대로인 파일은 tag와 달라도 사용자가 안 고친 것이다. 새 버전도 고친 파일은 git merge-file로 합친 안을
// 만들어 두기만 하고, 파일마다 유지(keep)·덮어쓰기(new)·섞기(merge)를 사용자에게 묻는다(깨끗이 합쳐져도 묻는다).
// 버전 사이에 옮겨진 파일은 scripts/update-moves.json(받은 저장소 최신 tag의 것)을 따라 옛 자리의 사용자 수정을 새 자리로 옮긴다.
// 기억 DB·모델·node_modules·*.local.*·키·백업·.git은 읽지도 고치지도 않고, 비서 고유 번호(.secretary-id)는 덮어쓰지 않는다(없으면 apply 끝에 만든다).
// 이 파일의 자리(scripts/update.mjs)는 바꾸지 않는다: 옛 버전의 update 스킬이 받은 저장소의 이 경로를 부른다.
// 스킬(v8부터 .agents/skills/<이름>에 실제 폴더, Claude Code가 읽는 .claude/skills는 그리로 가는 연결 하나. 공개하지 않은 v8 시험판은
// skills/<이름>과 스킬마다의 연결, v7은 .claude/skills/의 실제 폴더): apply 끝에 옛 자리에 남은 것(사용자가 만든 스킬, 사용자가 더한 파일, 아직 정하지 않은 파일)을
// .agents/skills/로 옮기고, 같은 명령 안에서 옛 연결을 지우고 새 연결을 만든다.
//
//   node <받은 저장소>/scripts/update.mjs backup  --user <비서 폴더>
//   node <받은 저장소>/scripts/update.mjs detect  --user <비서 폴더> --repo <받은 저장소>
//   node <받은 저장소>/scripts/update.mjs plan    --user <비서 폴더> --repo <받은 저장소> --base <tag>
//   node <받은 저장소>/scripts/update.mjs apply   --user <비서 폴더> --repo <받은 저장소> --base <tag> --work <백업 폴더>
//   node <받은 저장소>/scripts/update.mjs resolve --user <비서 폴더> --work <백업 폴더> --file <경로> --take keep|new|merge|merge-mine|merge-new|edited
//   node <받은 저장소>/scripts/update.mjs resolve --user <비서 폴더> --work <백업 폴더> --rest      (남은 것을 모두 추천대로)
// 타입은 JSDoc으로 단다(원본의 npm run test:dist가 배포판에서 이 파일을 checkJs strict로 검사한다).
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixSkillLinks, formatSkillLinkFix, isEmptyTree, OLD_SKILLS_DIR, SKILLS_DIR } from '../src/setup/skill-links.ts';

/** @typedef {Buffer | undefined} Raw A file's bytes; undefined when the file is not there. */
/** @typedef {'same' | 'add' | 'ask-add' | 'delete' | 'ask-delete' | 'ask-missing' | 'replace' | 'keep' | 'merge' | 'move' | 'move-keep' | 'ask-binary'} Action */
/** @typedef {{ path: string, from?: string, action: Action, base: Raw, user: Raw, theirs: Raw, byList?: boolean }} Item One file of the plan. */
/**
 * @typedef {object} Result One file as apply left it (update.json): what was done, or what is still to ask.
 * @property {string} path
 * @property {string} [from]
 * @property {Action} action
 * @property {'done' | 'ask' | 'conflict' | 'none' | 'resolved'} status ('conflict': written by an older update.mjs)
 * @property {string} [diff]
 * @property {string[]} [choices]
 * @property {number} [conflicts]
 * @property {string} [side]
 * @property {string} [recommend]
 * @property {string} [take]
 */
/** @typedef {'user' | 'repo' | 'base' | 'work' | 'file' | 'take'} Key */
/** @typedef {{ [k in Key]?: string } & { rest: boolean }} Options The command line. */
/** @typedef {{ moved: string[], kept: string[], made: string[] }} SkillMove */
/** @typedef {ReturnType<typeof fixSkillLinks>} LinkFix */

/** Never read or written by an update: personal data, downloads, local settings, keys, backups, the install's own id. */
export const PROTECTED = /(^|\/)(node_modules|backups|models|\.git|keys)(\/|$)|\.db(-wal|-shm|-journal)?$|\.db\.|\.embedder|\.local\.|\.env$|(^|\/)\.secretary-id$/;
/**
 * The install's own id (src/setup/install-id.ts): made once, kept for good, in upper case. An update never replaces it;
 * one coming from v7 (before ids) gets it at the end of apply, and one written in lower case is written again in upper
 * case. Same letters and length as install-id.ts (a test compares).
 */
export const ID_FILE = '.secretary-id';
export const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_PATTERN = /^[A-Z0-9]{4,12}$/;

/**
 * The user folder's install id, made and written when there is none: { id, created }.
 * @param {string} userDir
 * @returns {{ id: string, created: boolean }}
 */
export function ensureId(userDir) {
  const file = path.join(userDir, ID_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const id = raw.replace(/^﻿/, '').trim().toUpperCase();
    if (ID_PATTERN.test(id)) {
      if (raw !== `${id}\n`) fs.writeFileSync(file, `${id}\n`);
      return { id, created: false };
    }
  } catch {}
  const id = Array.from({ length: 4 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
  fs.writeFileSync(file, `${id}\n`);
  return { id, created: true };
}
/** Left out of the folder copy: the database has its own backup, the rest can be downloaded again. */
const NOT_COPIED = /(^|\/)(node_modules|backups|models|\.git)(\/|$)|\.db(-wal|-shm|-journal)?$/;
const BOM = '﻿';
/** The file in a release that lists the files each version moved. */
export const MOVES_FILE = 'scripts/update-moves.json';
/**
 * The release's file list (v8 on): every file the version shipped with a hash of its content (src/setup/release-files.ts).
 * The user's copy tells which files the user changed even where the git tag of that version differs (a rebuilt release);
 * it always comes from the new version.
 */
export const LIST_FILE = 'release-files.json';
/** The received repository this script came from. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Content for comparing: no BOM, LF line ends. Editors and zip tools change these without changing the file.
 * @param {string} text
 */
export function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/**
 * A file's hash as the release's file list has it: SHA-256 of the normalized text, a binary file (with a NUL byte) as it is. Same as src/setup/release-files.ts fileHash.
 * @param {Buffer} bytes
 */
export function fileHash(bytes) {
  const content = bytes.includes(0) ? bytes : Buffer.from(normalize(bytes.toString('utf8')), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The user's file list (path → hash) and its version; null without one (v7) or when it does not read.
 * @param {string} userDir
 * @returns {{ version?: string, files: Record<string, string> } | null}
 */
export function readList(userDir) {
  try {
    const list = JSON.parse(normalize(fs.readFileSync(path.join(userDir, LIST_FILE), 'utf8')));
    return list && typeof list.files === 'object' && list.files ? list : null;
  } catch {
    return null;
  }
}

/**
 * The base content to compare the user's file with. The git tag's, unless the user's file still has the hash the
 * user's file list gives it: then the user did not change it (the tag may differ, e.g. a release rebuilt after the user
 * got it), and the user's own content is the base. { base, byList }.
 * @param {Raw} tagBase
 * @param {Raw} user
 * @param {string | undefined} listHash
 * @returns {{ base: Raw, byList: boolean }}
 */
export function baseFor(tagBase, user, listHash) {
  if (user !== undefined && listHash !== undefined && fileHash(user) === listHash && (tagBase === undefined || text(tagBase) !== text(user))) return { base: user, byList: true };
  return { base: tagBase, byList: false };
}

/**
 * What to do with one file. Each side is the normalized content, or undefined when the file is not there.
 * base = the version the user installed, user = the user's folder now, theirs = the newest version.
 * @param {string | undefined} base
 * @param {string | undefined} user
 * @param {string | undefined} theirs
 * @returns {Action}
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
 * The same for a file the new version moved (base and user at the old path, theirs at the new one).
 * Unchanged by the user: it simply moves. Changed by the user only: the user's file moves as it is.
 * @param {string | undefined} base
 * @param {string | undefined} user
 * @param {string | undefined} theirs
 * @returns {Action}
 */
export function classifyMoved(base, user, theirs) {
  if (user === undefined) return 'ask-missing';
  if (user === base) return 'move';
  if (user === theirs || theirs === base) return 'move-keep';
  return 'merge';
}

/** The code files a version needs as they are: a new or missing one should come from the new version. */
const CODE = /\.(ts|mjs|js|ps1|json)$/;

/**
 * What the script recommends for a file it has to ask about (the secretary may recommend otherwise).
 * A clash in a code file takes the new version's side: there the user's side is often old code that no longer fits
 * (a file split into several clashes almost whole), and the user's change is kept in user-diffs to carry over by hand.
 * @param {Action} action
 * @param {string} filePath
 */
export function recommend(action, filePath, conflicts = 0) {
  if (action === 'merge') return conflicts ? (CODE.test(filePath) ? 'merge-new' : 'merge-mine') : 'merge';
  if (action === 'ask-delete') return 'new';
  if (action === 'ask-missing') return 'new';
  if (action === 'ask-add') return CODE.test(filePath) ? 'new' : 'keep';
  return 'keep';
}

// ---- versions --------------------------------------------------------------------------

/** @typedef {[number, number, number]} Version major, minor, patch */

/**
 * A version name (a tag, the VERSION file, a moves file key) as [major, minor, patch]: the first releases had one number
 * (v1 … v8), read as 0.N.0, so v8 is 0.8.0 and v0.9.0 comes after it; later ones are vX.Y.Z. The leading v may be left
 * out. null for anything else.
 * @param {string | undefined} name
 * @returns {Version | null}
 */
export function parseVersion(name) {
  const s = (name ?? '').trim().replace(/^v/i, '');
  const one = /^(\d+)$/.exec(s);
  if (one) return [0, Number(one[1]), 0];
  const three = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return three ? [Number(three[1]), Number(three[2]), Number(three[3])] : null;
}

/**
 * Older first: negative when a comes before b, 0 for the same version (v8 and 0.8.0), positive after. A name that is not
 * a version comes before every version.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Version tags oldest first, by their numbers (git's v:refname puts v0.9.0 before v1); other names are left out.
 * @param {string[]} names
 */
export function sortTags(names) {
  return names.filter((n) => parseVersion(n)).sort((a, b) => compareVersions(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The tag of the same version as `version` (a VERSION file's 'v8', '0.8.0' or 'v0.9.0'), or undefined.
 * @param {string[]} tags
 * @param {string | undefined} version
 */
export function findTag(tags, version) {
  if (!version || !parseVersion(version)) return undefined;
  return tags.find((t) => t === version) ?? tags.find((t) => parseVersion(t) && compareVersions(t, version) === 0);
}

/**
 * How a version is shown to the user: an old one-number tag with its 0.x number, 'v8(0.8.0)'; a new one as it is.
 * @param {string} tag
 */
export function versionLabel(tag) {
  const v = parseVersion(tag);
  return v && /^v?\d+$/i.test(tag.trim()) ? `${tag}(${v.join('.')})` : tag;
}

/**
 * Old path → path in the newest version, following every version after `base` up to `latest` in order.
 * moves: { "<tag>": { "<old path>": "<new path>" } } (the moves file of the newest version; a key names its version
 * the way the tag does, and a key of the same version in the other spelling, "0.9.0" for tag v0.9.0, is taken too).
 * @param {Record<string, Record<string, string>> | undefined} moves
 * @param {string[]} tags
 * @param {string} base
 * @param {string} latest
 */
export function movesBetween(moves, tags, base, latest) {
  const keys = Object.keys(moves ?? {}).filter((k) => parseVersion(k));
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const tag of sortTags(tags).filter((t) => compareVersions(t, base) > 0 && compareVersions(t, latest) <= 0)) {
    const key = moves?.[tag] ? tag : keys.find((k) => compareVersions(k, tag) === 0);
    const step = (key && moves?.[key]) || {};
    for (const [old, now] of map) if (step[now]) map.set(old, step[now]);
    for (const [old, now] of Object.entries(step)) if (!map.has(old)) map.set(old, now);
  }
  return map;
}

// ---- git -------------------------------------------------------------------------------

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {string} [input]
 */
function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * The repository's version tags, oldest first (sortTags: v1 … v8, then v0.9.0, …).
 * @param {string} repo
 */
export function listTags(repo) {
  return sortTags(git(repo, ['tag', '--list', 'v*']).toString().split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * path → blob sha for a tag.
 * @param {string} repo
 * @param {string} tag
 */
function tree(repo, tag) {
  const out = git(repo, ['ls-tree', '-r', '-z', tag]).toString();
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const [meta, p] = entry.split('\t');
    const [, type, sha] = meta.split(' ');
    if (type === 'blob' && !PROTECTED.test(p)) map.set(p, sha);
  }
  return map;
}

/**
 * Raw bytes of many blobs in one git process.
 * @param {string} repo
 * @param {string[]} shas
 */
function blobs(repo, shas) {
  const unique = [...new Set(shas)];
  /** @type {Map<string, Buffer>} */
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

/**
 * Each tag's files as path → raw bytes.
 * @param {string} repo
 * @param {string[]} tags
 * @returns {Map<string, Raw>[]}
 */
function versionFiles(repo, tags) {
  const trees = tags.map((t) => tree(repo, t));
  const raw = blobs(repo, trees.flatMap((t) => [...t.values()]));
  return trees.map((t) => new Map([...t].map(([p, sha]) => [p, raw.get(sha)])));
}

// ---- user folder -----------------------------------------------------------------------

/**
 * @param {string} userDir
 * @param {string} p
 * @returns {Raw}
 */
function userRaw(userDir, p) {
  const f = path.join(userDir, ...p.split('/'));
  return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : undefined;
}

/** @param {Raw} b */
const text = (b) => (b === undefined ? undefined : normalize(b.toString('utf8')));
/** @param {Raw} b */
const isBinary = (b) => b !== undefined && b.includes(0);

/**
 * Writes merged or chosen text back in the user's style: CRLF if the user's file had it, BOM if either side had one.
 * @param {string} textLf
 * @param {string} [userRawText]
 * @param {string} [theirsRawText]
 */
export function restyle(textLf, userRawText, theirsRawText) {
  const crlf = (userRawText ?? theirsRawText ?? '').includes('\r\n');
  const bom = [userRawText, theirsRawText].some((s) => s?.startsWith(BOM));
  return (bom ? BOM : '') + (crlf ? textLf.replace(/\n/g, '\r\n') : textLf);
}

/**
 * @param {string} userDir
 * @param {string} p
 * @param {string | Buffer} data
 */
function writeFile(userDir, p, data) {
  const f = path.join(userDir, ...p.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

/**
 * @param {string} userDir
 * @param {string} p
 */
function removeFile(userDir, p) {
  fs.rmSync(path.join(userDir, ...p.split('/')), { force: true });
}

/**
 * Removes a moved file's old place, unless it is the new file itself: in the v8 trial build, .agents/skills/<name> is a link to
 * skills/<name>, so the new path of a skill file reaches the old one until the end of apply moves the folder.
 * @param {string} userDir
 * @param {string} from
 * @param {string} to
 */
function removeOld(userDir, from, to) {
  const [f, t] = [from, to].map((p) => path.join(userDir, ...p.split('/')));
  try {
    if (fs.existsSync(t) && fs.realpathSync.native(f).toLowerCase() === fs.realpathSync.native(t).toLowerCase()) return;
  } catch {}
  removeFile(userDir, from);
}

/** Where v7 kept skills as real folders (the unreleased v8 trial build: skills/<name>; v8 on: .agents/skills/<name>, src/setup/skill-links.ts). */
export const OLD_SKILLS = '.claude/skills';
/** Ego Lite's own skill, put there by Ego Lite or the user: not the secretary's, stays where it is. */
const NOT_MOVED = new Set(['ego-browser']);

/**
 * Files under dir, relative (forward slashes); links are not entered.
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir, rel = '') {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Empty folders under dir, deepest first, then dir itself when it is left empty.
 * @param {string} dir
 */
function removeEmptyDirs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  if (isEmptyTree(dir)) fs.rmSync(dir, { recursive: true });
}

/**
 * v7 kept the skills as real folders in .claude/skills/<name>, the v8 trial build in skills/<name>; v8 keeps them in .agents/skills/<name>.
 * The plan moved the files the old version shipped (scripts/update-moves.json); what is left in a real folder of the old
 * place (oldDir) moves file by file to the same place under .agents/skills/: a skill the user made (a folder the old
 * version did not have), a file the user added to a secretary skill, a file still waiting for the user's choice (resolve
 * then settles it at its new place). A file .agents/skills/ already has with other content goes to <work>/skills-kept/
 * (the folder copy in <work>/files has it too) so the old folder empties. Links and Ego Lite's skill stay, and so does a
 * folder whose new place is a link (it may lead back here). known: the skill names the update knows (the new version's
 * and the moved ones). Returns { moved, kept, made } (paths; made: the other names, skills the user made).
 * @param {string} userDir
 * @param {string} workDir
 * @param {Set<string>} [known]
 * @returns {SkillMove}
 */
export function moveSkillFolders(userDir, workDir, known = new Set(), oldDir = OLD_SKILLS) {
  const from = path.join(userDir, ...oldDir.split('/'));
  /** @type {SkillMove} */
  const res = { moved: [], kept: [], made: [] };
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    // The old place made a link (v8's .claude/skills leads to .agents/skills): nothing of its own to move.
    if (fs.lstatSync(from).isSymbolicLink()) return res;
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return res;
  }
  /** @type {(a: string, b: string) => boolean} */
  const same = (a, b) => {
    try {
      return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
    } catch {
      return false;
    }
  };
  for (const e of entries) {
    // A junction or symbolic link is not a directory entry here: links stay.
    if (!e.isDirectory() || NOT_MOVED.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(userDir, ...SKILLS_DIR.split('/'), e.name);
    // A link at the new place may lead back here (the v8 trial build's per-skill link): moving file by file through it would delete them.
    try {
      if (fs.lstatSync(dst).isSymbolicLink() || same(src, dst)) continue;
    } catch {}
    if (!known.has(e.name) && !fs.existsSync(dst) && !isEmptyTree(src)) res.made.push(e.name);
    for (const rel of filesUnder(src)) {
      const a = path.join(src, ...rel.split('/'));
      const b = path.join(dst, ...rel.split('/'));
      const label = `${oldDir}/${e.name}/${rel}`;
      if (!fs.existsSync(b)) {
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.renameSync(a, b);
        res.moved.push(label);
      } else if (fileHash(fs.readFileSync(a)) === fileHash(fs.readFileSync(b))) fs.rmSync(a);
      else {
        const k = path.join(workDir, 'skills-kept', ...label.split('/'));
        fs.mkdirSync(path.dirname(k), { recursive: true });
        fs.renameSync(a, k);
        res.kept.push(k);
      }
    }
    removeEmptyDirs(src);
  }
  return res;
}

/**
 * git merge-file on normalized texts; { text, conflicts } with 내 것 / 새 버전 markers.
 * favor 'ours' / 'theirs' settles only the clashing parts that way; the parts that merged cleanly stay merged.
 * @param {string} base
 * @param {string} user
 * @param {string} theirs
 * @param {'ours' | 'theirs'} [favor]
 * @returns {{ text: string, conflicts: number }}
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
    } catch (e) {
      const err = /** @type {{ status?: unknown, stdout?: Buffer }} */ (e);
      // Exit code = number of conflicts (output still on stdout); negative means it failed.
      if (typeof err.status === 'number' && err.status > 0 && err.stdout) return { text: err.stdout.toString('utf8'), conflicts: err.status };
      throw e;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the user changed since the installed version, as a unified diff ('' when nothing).
 * @param {string | undefined} base
 * @param {string | undefined} user
 * @param {string} label
 */
export function userDiff(base, user, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-diff-'));
  try {
    const [b, u] = ['base', 'user'].map((n) => path.join(dir, n));
    fs.writeFileSync(b, base ?? '');
    fs.writeFileSync(u, user ?? '');
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', b, u], { maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
      return '';
    } catch (e) {
      const err = /** @type {{ status?: unknown, stdout?: Buffer }} */ (e);
      if (err.status !== 1 || !err.stdout) throw e;
      // Name the file instead of the temp paths (header lines only: before the first hunk).
      const lines = err.stdout.toString('utf8').split('\n');
      const first = lines.findIndex((l) => l.startsWith('@@'));
      const header = [`diff ${label}`, `--- 받았던 버전/${label}`, `+++ 지금 사용자 파일/${label}`];
      return [...header, ...lines.slice(first < 0 ? lines.length : first)].join('\n');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- commands --------------------------------------------------------------------------

/** @returns {Options} */
function args() {
  const a = process.argv.slice(3);
  /** @param {Key} k */
  const get = (k) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { user: get('user'), repo: get('repo'), base: get('base'), work: get('work'), file: get('file'), take: get('take'), rest: a.includes('--rest') };
}

/**
 * The options a command needs, checked: the same options, typed as present.
 * @template {Key} K
 * @param {Options} o
 * @param {...K} keys
 * @returns {Options & Record<K, string>}
 */
function need(o, ...keys) {
  for (const k of keys) if (!o[k]) throw new Error(`--${k} 가 필요해요`);
  if (o.user && !fs.existsSync(path.join(o.user, 'package.json'))) throw new Error(`비서 폴더가 아니에요(package.json 없음): ${o.user}`);
  return /** @type {Options & Record<K, string>} */ (o);
}

const stamp = () => {
  const d = new Date(Date.now() + 9 * 3600e3); // KST, so the folder name matches the user's clock
  return d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
};

/**
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
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

/** @param {Options} opts */
function cmdBackup(opts) {
  const o = need(opts, 'user');
  const work = path.join(o.user, 'backups', `update-${stamp()}`);
  const n = copyTree(o.user, path.join(work, 'files'));
  console.log(`백업 사본: ${work}\\files (파일 ${n}개, DB·모델·node_modules·backups 제외)`);
  console.log(`WORK=${work}`);
  // An older update skill runs this; the steps of this release (asking about every file both sides changed,
  // following moved files) are in the received repository's skill.
  const skill = [path.join(HERE, SKILLS_DIR, 'update', 'SKILL.md'), path.join(HERE, OLD_SKILLS_DIR, 'update', 'SKILL.md'), path.join(HERE, '.claude', 'skills', 'update', 'SKILL.md')].find((f) => fs.existsSync(f));
  if (path.resolve(o.user) !== HERE && skill) {
    console.log(`안내: 이번 업데이트의 순서는 받은 저장소의 스킬에 있어요: ${skill}`);
    console.log('      지금 따르는 순서와 다르면 그 파일을 읽고, 그 파일의 3단계(버전 판별)부터 그 순서를 따르세요.');
  }
}

/** @param {{ repo: string }} o */
function load(o) {
  const tags = listTags(o.repo);
  if (!tags.length) throw new Error(`받은 저장소에 v로 시작하는 tag가 없어요: ${o.repo}`);
  return { tags, latest: tags[tags.length - 1] };
}

/**
 * The version the user installed: the VERSION file (v7 on), else the file list's version (v8 on). A folder with
 * neither (a version before v7, or VERSION deleted) is not guessed: the user is asked (CLEAR=no, no BASE).
 * @param {Options} opts
 */
function cmdDetect(opts) {
  const o = need(opts, 'user', 'repo');
  const { tags, latest } = load(o);
  const version = text(userRaw(o.user, 'VERSION'))?.trim();
  const list = readList(o.user);
  console.log(`최신: ${versionLabel(latest)}`);
  console.log(`VERSION 파일: ${version ?? '(없음)'}`);
  if (list) {
    // What the user changed or removed among the files the installed version shipped (by hash, no git needed).
    /** @type {string[]} */
    const changed = [];
    /** @type {string[]} */
    const gone = [];
    for (const [p, hash] of Object.entries(list.files)) {
      const raw = userRaw(o.user, p);
      if (raw === undefined) gone.push(p);
      else if (fileHash(raw) !== hash) changed.push(p);
    }
    /** @param {string[]} xs */
    const some = (xs) => (xs.length ? ` (${xs.slice(0, 20).join(', ')}${xs.length > 20 ? ' 외' : ''})` : '');
    console.log(`파일 목록(${LIST_FILE}): ${list.version || '(버전 없음)'}, 목록 ${Object.keys(list.files).length}개 중 사용자가 고친 것 ${changed.length}개${some(changed)}, 지운 것 ${gone.length}개${some(gone)}`);
  } else console.log(`파일 목록(${LIST_FILE}): 없음 (v7은 tag 비교로만 찾는다)`);
  // VERSION first, then the file list's version; matched by number, so 'v8' finds tag v8 and '0.9.0' finds v0.9.0.
  const byVersion = findTag(tags, version);
  const byList = findTag(tags, list?.version);
  const known = byVersion ? { tag: byVersion, by: 'VERSION 파일' } : byList ? { tag: byList, by: `파일 목록 ${LIST_FILE}` } : null;
  if (known) {
    console.log(`판별: ${versionLabel(known.tag)} (${known.by})`);
    console.log(`BASE=${known.tag}`);
    console.log('CLEAR=yes');
    return;
  }
  // Updates start from v7 (the first version with VERSION); an older folder or a lost VERSION is the user's call.
  console.log(`판별: 못 함 (VERSION 파일${version ? `의 ${version}이 tag에 없고` : '도'} 파일 목록도 없음). 이 업데이트는 v7부터 올린다: 사용자에게 받았던 버전을 묻고, v7 이상이면 그 tag를 --base로 준다(있는 tag: ${tags.join(', ')})`);
  console.log('BASE=');
  console.log('CLEAR=no');
}

/**
 * The newest version's moves file, or {} if it has none.
 * @param {string} repo
 * @param {string} latest
 * @returns {Record<string, Record<string, string>>}
 */
function readMoves(repo, latest) {
  try {
    return JSON.parse(normalize(git(repo, ['show', `${latest}:${MOVES_FILE}`]).toString('utf8')));
  } catch {
    return {};
  }
}

/**
 * Every file of the base and newest versions with what to do about it.
 * @param {{ user: string, repo: string, base: string }} o
 */
function makePlan(o) {
  const { tags, latest } = load(o);
  // --base by number too: 'v8', '0.8.0' and 'v0.8.0' are tag v8.
  const base = findTag(tags, o.base);
  if (!base) throw new Error(`없는 tag예요: ${o.base} (있는 것: ${tags.join(', ')})`);
  const [baseFiles, newFiles] = versionFiles(o.repo, [base, latest]);
  const moves = movesBetween(readMoves(o.repo, latest), tags, base, latest);
  // The user's file list (v8 on): a file still matching its hash was not changed by the user, whatever the tag says.
  const listed = readList(o.user)?.files ?? {};
  /** @type {Item[]} */
  const items = [];
  /** @type {Set<string>} */
  const done = new Set();
  // Files the new version moved: the user's file at the old path against the new one at its new path.
  for (const [from, to] of moves) {
    if (!baseFiles.has(from) || !newFiles.has(to) || newFiles.has(from) || done.has(to)) continue;
    const u = userRaw(o.user, from);
    const { base: b, byList } = baseFor(baseFiles.get(from), u, listed[from]);
    const t = newFiles.get(to);
    let action = classifyMoved(text(b), text(u), text(t));
    if (action === 'merge' && [b, u, t].some(isBinary)) action = 'ask-binary';
    items.push({ path: to, from, action, base: b, user: u, theirs: t, ...(byList ? { byList } : {}) });
    done.add(from).add(to);
  }
  const paths = [...new Set([...baseFiles.keys(), ...newFiles.keys()])].filter((p) => !done.has(p)).sort();
  for (const p of paths) {
    const u = userRaw(o.user, p);
    const t = newFiles.get(p);
    if (p === LIST_FILE) {
      // The list describes the version in the folder: always the new version's, never a question.
      items.push({ path: p, action: t === undefined ? (u === undefined ? 'same' : 'delete') : u !== undefined && text(u) === text(t) ? 'same' : u === undefined ? 'add' : 'replace', base: baseFiles.get(p), user: u, theirs: t });
      continue;
    }
    const { base: b, byList } = baseFor(baseFiles.get(p), u, listed[p]);
    let action = classify(text(b), text(u), text(t));
    if (action === 'merge' && [b, u, t].some(isBinary)) action = 'ask-binary';
    items.push({ path: p, action, base: b, user: u, theirs: t, ...(byList ? { byList } : {}) });
  }
  items.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { base, latest, items };
}

/** @type {Record<string, string>} */
const LABEL = {
  replace: '새 버전으로 바꿈(사용자가 안 고친 파일)',
  add: '새 파일 추가',
  delete: '지움(새 버전에서 없어졌고 사용자가 안 고침)',
  move: '새 자리로 옮김(사용자가 안 고친 파일, 새 버전 내용으로)',
  'move-keep': '새 자리로 옮김(사용자가 고친 내용 그대로, 새 버전은 내용을 안 바꿈)',
  keep: '사용자 것 그대로(새 버전에서 안 바뀜)',
  merge: '물어볼 것: 사용자도 새 버전도 고침(유지·덮어쓰기·섞기)',
  'ask-add': '물어볼 것: 새 버전이 추가한 파일과 같은 이름의 사용자 파일이 있음',
  'ask-delete': '물어볼 것: 새 버전에서 지운 파일을 사용자가 고쳤음',
  'ask-missing': '물어볼 것: 사용자가 지운 파일이 새 버전에서 바뀜',
  'ask-binary': '물어볼 것: 둘 다 고친 바이너리 파일',
};

/** @param {{ path: string, from?: string }} i */
const where = (i) => (i.from ? `${i.path} (옛 자리 ${i.from})` : i.path);

/**
 * @param {string} latest
 * @param {string} base
 * @param {Item[]} items
 */
function printPlan(latest, base, items) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const i of items) counts[i.action] = (counts[i.action] ?? 0) + 1;
  console.log(`기준 ${versionLabel(base)} → 최신 ${versionLabel(latest)}`);
  if (items.every((i) => i.action === 'same' || i.action === 'keep')) {
    console.log('이미 최신이에요(바꿀 파일 없음).');
    return;
  }
  for (const [action, label] of Object.entries(LABEL)) {
    const list = items.filter((i) => i.action === action);
    if (!list.length) continue;
    console.log(`${label}: ${list.length}개`);
    for (const i of list) console.log(`  - ${where(i)}`);
  }
  console.log(`변경 없음: ${counts.same ?? 0}개`);
  // The tag differed from the user's file, but the user's file list says the user never changed it.
  const byList = items.filter((i) => i.byList && i.action !== 'same');
  if (byList.length) console.log(`파일 목록(${LIST_FILE}) 해시로 사용자가 안 고친 것으로 본 파일: ${byList.length}개 (받았던 판이 tag와 조금 달랐음)`);
}

/** @param {Options} opts */
function cmdPlan(opts) {
  const o = need(opts, 'user', 'repo', 'base');
  const { base, latest, items } = makePlan(o);
  printPlan(latest, base, items);
}

/** Choices a question can offer, by kind of item. */
const CHOICES = {
  merge: ['keep', 'new', 'merge', 'edited'],
  conflict: ['keep', 'new', 'merge-mine', 'merge-new', 'edited'],
  ask: ['keep', 'new'],
};

/** @param {Options} opts */
function cmdApply(opts) {
  const o = need(opts, 'user', 'repo', 'base', 'work');
  if (!fs.existsSync(path.join(o.work, 'files'))) throw new Error(`백업 사본이 없어요. backup을 먼저 돌리세요: ${o.work}`);
  const { base, latest, items } = makePlan(o);
  printPlan(latest, base, items);
  const pkgBefore = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  /** @type {Result[]} */
  const results = [];
  /** @type {(dir: string, p: string, data: string | Buffer) => string} */
  const keepCopy = (dir, p, data) => {
    const f = path.join(o.work, dir, ...p.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    return f;
  };
  for (const i of items) {
    /** @type {Result} */
    const r = { path: i.path, ...(i.from ? { from: i.from } : {}), action: i.action, status: 'done' };
    /** @param {string} t */
    const style = (t) => restyle(t, i.user?.toString('utf8'), i.theirs?.toString('utf8'));
    // replace, add and move have the new version's file, move-keep the user's, and a move its old path (makePlan).
    if (i.action === 'replace' || i.action === 'add') writeFile(o.user, i.path, /** @type {Buffer} */ (i.theirs));
    else if (i.action === 'delete') removeFile(o.user, i.path);
    else if (i.action === 'move') {
      writeFile(o.user, i.path, /** @type {Buffer} */ (i.theirs));
      removeOld(o.user, /** @type {string} */ (i.from), i.path);
    } else if (i.action === 'move-keep') {
      writeFile(o.user, i.path, /** @type {Buffer} */ (i.user));
      removeOld(o.user, /** @type {string} */ (i.from), i.path);
    } else if (i.action === 'merge' || i.action.startsWith('ask-')) {
      // Nothing is written to the user's folder until the user decides. Waiting in the work folder: the new
      // version (new/), the user's file (keep/), and for a merge the merged text (merged/) or, when parts clash,
      // the marked-up merge (conflicts/) and the merge with the clashes settled each way (merged-mine/, merged-new/).
      r.status = 'ask';
      if (i.theirs !== undefined) keepCopy('new', i.path, i.theirs);
      if (i.user !== undefined) keepCopy('keep', i.path, i.user);
      if (i.user !== undefined && i.base !== undefined && !isBinary(i.user)) {
        const d = userDiff(text(i.base), text(i.user), i.from ?? i.path);
        if (d) r.diff = keepCopy('user-diffs', `${i.path}.diff`, d);
      }
      r.choices = CHOICES.ask;
      if (i.action === 'merge') {
        // A merge has all three sides (classify, classifyMoved): the '' never comes into play.
        const [b, u, t] = [text(i.base), text(i.user), text(i.theirs)].map((s) => s ?? '');
        const m = merge3(b, u, t);
        r.conflicts = m.conflicts;
        if (m.conflicts === 0) {
          // Also the starting point for a hand-made mix (edited).
          r.side = keepCopy('merged', i.path, style(m.text));
          r.choices = CHOICES.merge;
        } else {
          r.side = keepCopy('conflicts', i.path, style(m.text));
          keepCopy('merged-mine', i.path, style(merge3(b, u, t, 'ours').text));
          keepCopy('merged-new', i.path, style(merge3(b, u, t, 'theirs').text));
          r.choices = CHOICES.conflict;
        }
      }
      r.recommend = recommend(i.action, i.path, r.conflicts ?? 0);
    } else r.status = 'none';
    results.push(r);
  }
  const pkgAfter = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  const installId = ensureId(o.user);
  // Skills: what is left in the old places moves to .agents/skills/, and the links are put right in this same command,
  // so the CLI never finds a skill folder empty between two commands (the session running this update follows the
  // received repository's update skill by its path, which does not move).
  // The skill names this update knows (a skill folder of the new version or of the installed one): any other is the user's.
  /** @type {(p: string | undefined) => string | null} */
  const skillName = (p) => {
    for (const d of [SKILLS_DIR, OLD_SKILLS_DIR, OLD_SKILLS]) if (p?.startsWith(`${d}/`)) return p.slice(d.length + 1).split('/')[0];
    return null;
  };
  const known = new Set(/** @type {string[]} */ (items.flatMap((i) => [skillName(i.path), skillName(i.from)]).filter(Boolean)));
  // v7: real folders in .claude/skills, file by file. The v8 trial build: the per-skill links go and skills/<name> moves whole (the
  // layout fix), then what met a folder of the same name goes file by file, and the layout fix runs again to finish.
  const fromV7 = moveSkillFolders(o.user, o.work, known);
  const first = fixSkillLinks(o.user);
  const fromV8 = moveSkillFolders(o.user, o.work, known, OLD_SKILLS_DIR);
  const last = fixSkillLinks(o.user);
  const whole = first.moved.map((m) => m.split(' → ')[0]).filter((f) => f.startsWith(`${OLD_SKILLS_DIR}/`) || f.startsWith(`${OLD_SKILLS}/`));
  const skillMove = {
    moved: [...fromV7.moved, ...fromV8.moved],
    kept: [...fromV7.kept, ...fromV8.kept],
    made: [...new Set([...fromV7.made, ...fromV8.made, .../** @type {string[]} */ (whole.map(skillName).filter((n) => n && !known.has(n) && n !== 'ego-browser'))])],
    folders: whole,
  };
  const links = { ...last, made: [...first.made, ...last.made], remade: [...first.remade, ...last.remade], removed: [...first.removed, ...last.removed], moved: [...first.moved, ...last.moved] };
  const state = { base, latest, packageChanged: pkgBefore.some((x, k) => x !== pkgAfter[k]), installId, skills: { ...skillMove, links }, results };
  fs.writeFileSync(path.join(o.work, 'update.json'), JSON.stringify(state, null, 1));
  console.log('');
  console.log(`적용함: ${results.filter((r) => r.status === 'done').length}개`);
  console.log(`package.json 바뀜: ${state.packageChanged ? '예 (npm install 필요)' : '아니요'}`);
  console.log(
    installId.created
      ? `비서 고유 번호: ${installId.id} (새로 만듦, ${ID_FILE}). 예약 작업 이름 끝에 붙는다: 옛 이름 작업은 "올린 뒤 할 일"대로 새 이름으로 옮긴다`
      : `비서 고유 번호: ${installId.id} (그대로, ${ID_FILE})`,
  );
  printSkills(skillMove, links);
  printOpen(state);
}

/**
 * @param {SkillMove & { folders?: string[] }} move
 * @param {LinkFix} links
 */
function printSkills(move, links) {
  const made = move.made.length ? ` (사용자가 만든 스킬: ${move.made.join(', ')})` : '';
  if (move.moved.length || move.kept.length || move.folders?.length || move.made.length)
    console.log(`스킬 자리: 옛 자리(${OLD_SKILLS}/, ${OLD_SKILLS_DIR}/)에서 ${SKILLS_DIR}/로 옮긴 폴더 ${move.folders?.length ?? 0}개, 파일 ${move.moved.length}개${made}`);
  for (const k of move.kept) console.log(`  - 같은 자리에 내용이 다른 파일이 있어 옮기지 않고 따로 둠: ${k}`);
  for (const line of formatSkillLinkFix(links, false)) console.log(line);
  if (links.failed.length || links.kept.length) console.log('  → 업데이트를 마친 뒤 사용자 폴더에서 `node src/cli.ts skill-links`로 다시 만든다(설치 점검 항목 skills가 알린다)');
}

/** @param {Result} r */
const isOpen = (r) => r.status === 'ask' || r.status === 'conflict';

/** @param {{ results: Result[] }} state */
function printOpen(state) {
  const open = state.results.filter(isOpen);
  if (!open.length) {
    console.log('남은 부딪힘: 없음');
    return;
  }
  console.log(`남은 부딪힘: ${open.length}개 (파일마다 사용자에게 물어볼 것, 그동안 사용자 파일은 그대로)`);
  for (const r of open) {
    const merged = r.side ? ` · 합친 안: ${r.side}${r.conflicts ? ` (부딪힌 곳 ${r.conflicts}군데)` : ' (깨끗이 합쳐짐)'}` : '';
    console.log(`  - ${where(r)} · ${LABEL[r.action]}${merged} · 고를 것: ${(r.choices ?? []).join('/')} · 추천: ${r.recommend}${r.diff ? ` · 사용자 수정: ${r.diff}` : ''}`);
  }
}

/**
 * Puts one choice in place; for a moved file the old path goes once the new one is settled.
 * @param {{ user: string, work: string }} o
 * @param {Result} r
 * @param {string} take
 */
function settle(o, r, take) {
  /** @param {string} dir */
  const copy = (dir) => path.join(o.work, dir, ...r.path.split('/'));
  /** @param {string} dir */
  const has = (dir) => fs.existsSync(copy(dir));
  // v7's update skill offers mine/new/edited: "mine" kept the user's side of a clash and took the rest of the merge.
  if (take === 'mine') take = r.action === 'merge' ? (r.conflicts ? 'merge-mine' : 'merge') : 'keep';
  const choices = r.choices ?? [];
  if (!choices.includes(take)) throw new Error(`${r.path}에는 ${take}를 고를 수 없어요(고를 것: ${choices.join(', ')})`);
  if (take === 'keep') {
    // The user's file as it is: stays where it is, or for a moved file goes to the new path.
    if (r.from && has('keep')) writeFile(o.user, r.path, fs.readFileSync(copy('keep')));
  } else if (take === 'new') {
    if (has('new')) writeFile(o.user, r.path, fs.readFileSync(copy('new')));
    else removeFile(o.user, r.path);
  } else if (take === 'merge') writeFile(o.user, r.path, fs.readFileSync(copy('merged')));
  else if (take === 'merge-mine') writeFile(o.user, r.path, fs.readFileSync(copy('merged-mine')));
  else if (take === 'merge-new') writeFile(o.user, r.path, fs.readFileSync(copy('merged-new')));
  else if (take === 'edited') {
    // 'edited' is offered only with a merged or marked-up copy (side).
    const edited = fs.readFileSync(/** @type {string} */ (r.side), 'utf8');
    // Only the labelled markers merge3 writes, so a Markdown "=======" underline in the user's text is not mistaken for one.
    if (/^(<<<<<<< 내 것|>>>>>>> 새 버전)\r?$/m.test(edited)) throw new Error(`합친 안에 표시(<<<<<<< 등)가 남아 있어요: ${r.side}`);
    writeFile(o.user, r.path, edited);
  }
  if (r.from && r.from !== r.path) removeOld(o.user, r.from, r.path);
  Object.assign(r, { status: 'resolved', take });
}

/** @param {Options} opts */
function cmdResolve(opts) {
  const o = need(opts, 'user', 'work');
  const one = o.rest ? null : need(o, 'file', 'take');
  const stateFile = path.join(o.work, 'update.json');
  /** @type {{ results: Result[] }} */
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // Written by an older update.mjs: give its items the choices this one knows.
  for (const r of state.results) if (isOpen(r) && !r.choices) Object.assign(r, { choices: r.status === 'conflict' ? CHOICES.conflict : CHOICES.ask, recommend: 'keep' });
  if (!one) {
    const open = state.results.filter(isOpen);
    for (const r of open) settle(o, r, r.recommend ?? 'keep');
    console.log(`추천대로 정함: ${open.map((r) => `${r.path} → ${r.take}`).join(', ') || '(남은 것 없음)'}`);
  } else {
    const r = state.results.find((x) => x.path === one.file || x.from === one.file);
    if (!r || !isOpen(r)) throw new Error(`남은 부딪힘이 아니에요: ${one.file}`);
    settle(o, r, one.take);
    console.log(`정리함: ${r.path} → ${r.take}`);
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  const left = state.results.filter(isOpen).map((x) => x.path);
  console.log(`남은 부딪힘: ${left.length ? left.join(', ') : '없음'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /** @type {Record<string, (o: Options) => void>} */
  const cmds = { backup: cmdBackup, detect: cmdDetect, plan: cmdPlan, apply: cmdApply, resolve: cmdResolve };
  const cmd = cmds[process.argv[2]];
  try {
    if (!cmd) throw new Error('usage: node scripts/update.mjs backup|detect|plan|apply|resolve --user <비서 폴더> [--repo <받은 저장소>] [--base <tag>] [--work <백업 폴더>] [--file <경로> --take <고른 것> | --rest]');
    const o = args();
    for (const k of /** @type {const} */ (['user', 'repo', 'work'])) {
      const v = o[k];
      if (v) o[k] = path.resolve(v);
    }
    // Paths in the plan are repo-style (src/recall.ts); PowerShell users may type src\recall.ts.
    if (o.file) o.file = o.file.replace(/\\/g, '/').replace(/^\.\//, '');
    cmd(o);
  } catch (err) {
    console.error(`오류: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
