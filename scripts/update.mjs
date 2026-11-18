// @ts-check
// 비서 업데이트 도우미(.agents/skills/secretary-update/SKILL.md가 부른다). AI를 부르지 않고 git과 Node 기본 기능만 쓴다.
// 사용자 폴더(zip을 풀어 쓰며 고쳤을 수 있는 비서 폴더)를 받은 저장소(git clone, tag v0.11.0, v0.12.0, …)의 최신 tag로 올린다(v0.11.0부터(MIN_BASE), 받았던 버전은 VERSION 파일로 안다).
// 버전 번호: 0.x 세 자리(v0.11.0, semver: 끝자리 고침, 가운데 기능 추가, 앞자리 사용자가 손봐야 하는 변경)이고,
// tag 순서는 git의 이름 정렬이 아니라 이 번호로 센다(parseVersion, sortTags).
// 사용자가 고친 파일은 기준 tag(사용자가 받았던 버전)와 비교해 찾고, 사용자 폴더의 배포판 파일 목록(release-files.json,
// 받았던 판의 파일마다 내용 해시)으로도 본다: 해시가 그대로인 파일은 tag와 달라도 사용자가 안 고친 것이다. 새 버전도 고친 파일은 git merge-file로 합친 안을
// 만들어 두기만 하고, 파일마다 유지(keep)·덮어쓰기(new)·섞기(merge)를 사용자에게 묻는다(깨끗이 합쳐져도 묻는다).
// 설정 JSON(.json, package-lock.json 빼고)은 줄이 부딪히면 키 단위로 합친 안(양쪽이 더한 항목을 모두 살림, mergeJson)을 만들어 추천한다.
// VERSION과 release-files.json은 물을 것을 모두 정한 뒤에 쓴다(writeVersionMarks): 중간에 그만두면 다음 업데이트도 옛 버전에서 올린다.
// 버전 사이에 옮겨진 파일은 scripts/update-moves.json(받은 저장소 최신 tag의 것)을 따라 옛 자리의 사용자 수정을 새 자리로 옮긴다.
// 기억 DB·모델·node_modules·*.local.*·키·백업·.git은 읽지도 고치지도 않고, 비서 고유 번호(.secretary-id)는 덮어쓰지 않는다(없으면 apply 끝에 만든다).
// 이 파일의 자리(scripts/update.mjs)는 바꾸지 않는다: 사용자 폴더에 있는 옛 버전의 업데이트 스킬이 받은 저장소의 이 경로를 부른다.
// 스킬은 .agents/skills/<이름>에 실제 폴더로 있고, Claude Code가 읽는 .claude/skills는 그리로 가는 연결 하나다: apply 끝에 연결을 맞춘다(src/workspace/skill-links.ts).
// 배포판이 싣는 공통 스킬(common-skills/<이름>)은 설치가 사용자 workspaces/_skills/<이름>에 복사해 두고 사용자는 그쪽을 고친다: 그 복사본도
// 비서 파일처럼 기준 tag의 파일(사용자 폴더의 release-files.json 해시와 함께)과 견줘 합치고 묻는다(skillsPlace). 비서 폴더 안의 common-skills/는 설치 원본이라 늘 새 버전으로 둔다.
//
//   node <받은 저장소>/scripts/update.mjs backup  --user <비서 폴더>
//   node <받은 저장소>/scripts/update.mjs detect  --user <비서 폴더> --repo <받은 저장소>
//   node <받은 저장소>/scripts/update.mjs plan    --user <비서 폴더> --repo <받은 저장소> --base <tag>
//   node <받은 저장소>/scripts/update.mjs apply   --user <비서 폴더> --repo <받은 저장소> --base <tag> --work <백업 폴더>
//   node <받은 저장소>/scripts/update.mjs resolve --user <비서 폴더> --work <백업 폴더> --file <경로> --take keep|new|merge|merge-mine|merge-new|edited
//   node <받은 저장소>/scripts/update.mjs resolve --user <비서 폴더> --work <백업 폴더> --rest      (남은 것을 모두 추천대로)
//   node <받은 저장소>/scripts/update.mjs finish  --user <비서 폴더>      (npm install 뒤: workspace-links)
// 타입은 JSDoc으로 단다(원본의 npm run test:release-build가 배포판에서 이 파일을 checkJs strict로 검사한다).
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixSkillLinks, formatSkillLinkFix, SKILLS_DIR } from '../src/workspace/skill-links.ts';
import { featureSkillPath, featureSkills, fixFeatureSkills, formatFeatureSkills } from '../src/setup/feature-skills.ts';
import { commonSkillsDirOf, SHIPPED_COMMON_SKILLS_DIR } from '../src/workspace/common-skills.ts';

/** @typedef {Buffer | undefined} Raw A file's bytes; undefined when the file is not there. */
/** @typedef {'same' | 'add' | 'ask-add' | 'delete' | 'ask-delete' | 'ask-missing' | 'replace' | 'keep' | 'merge' | 'move' | 'move-keep' | 'ask-binary'} Action */
/** @typedef {{ path: string, from?: string, action: Action, base: Raw, user: Raw, theirs: Raw, byList?: boolean }} Item One file of the plan. */
/**
 * @typedef {object} Result One file as apply left it (update.json): what was done, or what is still to ask.
 * @property {string} path
 * @property {string} [from]
 * @property {Action} action
 * @property {'done' | 'ask' | 'none' | 'resolved' | 'later'} status ('later': VERSION or the file list, written once nothing is left to ask)
 * @property {string} [diff]
 * @property {string[]} [choices]
 * @property {number} [conflicts]
 * @property {boolean} [byKeys] a JSON file whose clashing lines were merged by key (merged/)
 * @property {string[]} [keyClashes] where both sides changed the same JSON value (the user's value kept, package.json the new one)
 * @property {string} [side]
 * @property {string} [recommend]
 * @property {string} [take]
 */
/** @typedef {'user' | 'repo' | 'base' | 'work' | 'file' | 'take'} Key */
/** @typedef {{ [k in Key]?: string } & { rest: boolean }} Options The command line. */
/** @typedef {ReturnType<typeof fixSkillLinks>} LinkFix */

/** Never read or written by an update: personal data, downloads, local settings, keys, backups, the install's own id. */
export const PROTECTED = /(^|\/)(node_modules|backups|models|\.git|keys)(\/|$)|\.db(-wal|-shm|-journal)?$|\.db\.|\.local\.(?!example\.)|\.env$|(^|\/)\.secretary-id$/;
/**
 * The secretary's own id (src/core/secretary-id.ts): made once, kept for good, in upper case. An update never replaces it;
 * a folder without one gets it at the end of apply, and one written in lower case is written again in upper
 * case. Same letters and length as secretary-id.ts (a test compares): no vowels, so a new id never spells a word. An id
 * made before (with vowels) still reads (ID_PATTERN is wider).
 */
export const ID_FILE = '.secretary-id';
export const ID_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
const ID_PATTERN = /^[A-Z0-9]{4,12}$/;

/**
 * The user folder's secretary id, made and written when there is none: { id, created }.
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
/** The oldest version an update starts from: detect does not take an older one, plan and apply stop on it. */
export const MIN_BASE = 'v0.11.0';
/**
 * The release's file list: every file the version shipped with a hash of its content (src/setup/release-files.ts).
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
 * The user's file list (path → hash) and its version; null without one or when it does not read.
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
/** npm's own list (npm install writes it again): not a file the user adds to, its clashes take the new version's side. */
const NPM_LOCK = /(^|\/)package-lock\.json$/;
/** A value both sides changed takes the new version's here: the code it ships needs the parts it names. */
const NEW_VALUE_WINS = /(^|\/)package\.json$/;
/**
 * The JSON files merged by key when their lines clash: settings the user adds to (the common skill list, providers,
 * permissions, features.json …). A line merge of JSON clashes where both sides add to the end of the same list, and
 * either side of the clash drops the other's entries.
 * @param {string} filePath
 */
export const keyMerged = (filePath) => filePath.endsWith('.json') && !NPM_LOCK.test(filePath);

/**
 * What the script recommends for a file it has to ask about (the secretary may recommend otherwise).
 * A clash in a code file takes the new version's side: there the user's side is often old code that no longer fits
 * (a file split into several clashes almost whole), and the user's change is kept in user-diffs for the secretary to carry over itself.
 * A JSON file merged by key (byKeys: both sides' entries kept, mergeJson) takes that merge; one that does not read as JSON
 * takes the user's side of the clash, so what the user added (a common skill, a provider, a permission) is not dropped
 * by "the rest as recommended". features.json too: whatever is chosen, the features the user turned on or off get the user's
 * value back (carryFeatureStates).
 * @param {Action} action
 * @param {string} filePath
 */
export function recommend(action, filePath, conflicts = 0, byKeys = false) {
  if (action === 'merge') {
    if (!conflicts || byKeys) return 'merge';
    if (keyMerged(filePath) && !NEW_VALUE_WINS.test(filePath)) return 'merge-mine';
    return CODE.test(filePath) ? 'merge-new' : 'merge-mine';
  }
  if (action === 'ask-delete') return 'new';
  if (action === 'ask-missing') return 'new';
  if (action === 'ask-add') return CODE.test(filePath) ? 'new' : 'keep';
  return 'keep';
}

// ---- JSON by key ---------------------------------------------------------------------------

/** @param {unknown} v */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A value as text with object keys sorted, for telling equal values (key order does not count).
 * @param {unknown} v
 * @returns {string | undefined}
 */
function canon(v) {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return `[${v.map((x) => canon(x) ?? 'null').join(',')}]`;
  if (isPlainObject(v)) {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The key an array item is matched by across the three sides: its "id" or "name" when every item of the three has a string
 * one (features, providers' lists), else the item itself. null when a side holds two items of the same key (then the list is
 * not merged item by item).
 * @param {unknown[][]} arrays
 * @returns {((x: unknown) => string) | null}
 */
function itemKey(arrays) {
  const items = arrays.flat();
  const field = ['id', 'name'].find((f) => items.length > 0 && items.every((x) => isPlainObject(x) && typeof (/** @type {Record<string, unknown>} */ (x))[f] === 'string'));
  /** @param {unknown} x */
  const key = (x) => (field ? `${field}:${(/** @type {Record<string, unknown>} */ (x))[field]}` : `=${canon(x)}`);
  for (const a of arrays) if (new Set(a.map(key)).size !== a.length) return null;
  return key;
}

/**
 * Three-way merge of parsed JSON: objects key by key, lists item by item (what either side added stays, what either side
 * removed and the other left goes), other values whole. Where both sides changed the same place differently, `prefer`'s
 * value is taken and the place listed in clashes ("providers.default", "skills[]").
 * @param {unknown} base
 * @param {unknown} user
 * @param {unknown} theirs
 * @param {'user' | 'theirs'} [prefer]
 * @returns {{ value: unknown, clashes: string[] }}
 */
export function mergeJson(base, user, theirs, prefer = 'user') {
  /** @type {string[]} */
  const clashes = [];
  /**
   * @param {unknown} b
   * @param {unknown} u
   * @param {unknown} t
   * @param {string} at
   * @returns {unknown}
   */
  const walk = (b, u, t, at) => {
    if (canon(u) === canon(t)) return u;
    if (canon(b) === canon(u)) return t;
    if (canon(b) === canon(t)) return u;
    if (isPlainObject(u) && isPlainObject(t) && (b === undefined || isPlainObject(b))) {
      const [bo, uo, to] = /** @type {Record<string, unknown>[]} */ ([b ?? {}, u, t]);
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of [...new Set([...Object.keys(to), ...Object.keys(uo)])]) {
        const v = walk(bo[k], uo[k], to[k], at ? `${at}.${k}` : k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(u) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      const ba = /** @type {unknown[]} */ (b ?? []);
      const key = itemKey([ba, u, t]);
      if (key) {
        const [bm, um, tm] = [ba, u, t].map((a) => new Map(a.map((x) => [key(x), x])));
        /** @type {unknown[]} */
        const out = [];
        for (const k of [...new Set([...tm.keys(), ...um.keys()])]) {
          const v = walk(bm.get(k), um.get(k), tm.get(k), `${at}[]`);
          if (v !== undefined) out.push(v);
        }
        return out;
      }
    }
    clashes.push(at || '(전체)');
    return prefer === 'user' ? u : t;
  };
  return { value: walk(base, user, theirs, ''), clashes };
}

/**
 * The key-by-key merge of a JSON file's three texts, written as the new version writes it (its indent, its last newline):
 * { text, clashes }, or null when a side does not read as JSON. package.json takes the new version's value where both changed one.
 * @param {string} filePath
 * @param {string} base
 * @param {string} user
 * @param {string} theirs
 */
export function mergeJsonText(filePath, base, user, theirs) {
  /** @type {unknown[]} */
  let parsed;
  try {
    parsed = [base, user, theirs].map((s) => JSON.parse(normalize(s)));
  } catch {
    return null;
  }
  const m = mergeJson(parsed[0], parsed[1], parsed[2], NEW_VALUE_WINS.test(filePath) ? 'theirs' : 'user');
  const indent = /\n([ \t]+)\S/.exec(normalize(theirs))?.[1] ?? '  ';
  return { text: JSON.stringify(m.value, null, indent) + (normalize(theirs).endsWith('\n') ? '\n' : ''), clashes: m.clashes };
}

/** @param {string} s */
const readsAsJson = (s) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

// ---- versions --------------------------------------------------------------------------

/** @typedef {[number, number, number]} Version major, minor, patch */

/**
 * A version name (a tag, the VERSION file, a moves file key) as [major, minor, patch]: vX.Y.Z, the leading v may be left
 * out. null for anything else.
 * @param {string | undefined} name
 * @returns {Version | null}
 */
export function parseVersion(name) {
  const s = (name ?? '').trim().replace(/^v/i, '');
  const three = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return three ? [Number(three[1]), Number(three[2]), Number(three[3])] : null;
}

/**
 * Older first: negative when a comes before b, 0 for the same version (v0.11.0 and 0.11.0), positive after. A name that is not
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
 * Version tags oldest first, by their numbers (a plain name sort puts v0.100.0 before v0.11.0); other names are left out.
 * @param {string[]} names
 */
export function sortTags(names) {
  return names.filter((n) => parseVersion(n)).sort((a, b) => compareVersions(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The tag of the same version as `version` (a VERSION file's 'v0.11.0' or '0.11.0'), or undefined.
 * @param {string[]} tags
 * @param {string | undefined} version
 */
export function findTag(tags, version) {
  if (!version || !parseVersion(version)) return undefined;
  return tags.find((t) => t === version) ?? tags.find((t) => parseVersion(t) && compareVersions(t, version) === 0);
}

/**
 * Old path → path in the newest version, following every version after `base` up to `latest` in order.
 * moves: { "<version>": { "<old path>": "<new path>" } } (the moves file of the newest version; a key names its version
 * the way the tag does, and a key of the same version in the other spelling, "0.11.0" for tag v0.11.0, is taken too).
 * The versions are the tags and the keys together: only the versions the author chose are published (e.g. v0.11.0, then
 * v0.13.0), so a key may name a version that never had a tag (v0.12.0), and its moves are followed all the same.
 * @param {Record<string, Record<string, string>> | undefined} moves
 * @param {string[]} tags
 * @param {string} base
 * @param {string} latest
 */
export function movesBetween(moves, tags, base, latest) {
  const keys = Object.keys(moves ?? {}).filter((k) => parseVersion(k));
  /** @type {Map<string, string>} */
  const map = new Map();
  /** One name per version (a tag before a key of the same version), oldest first. */
  const versions = sortTags([...tags, ...keys]).filter((v, i, all) => compareVersions(v, base) > 0 && compareVersions(v, latest) <= 0 && all.findIndex((w) => compareVersions(w, v) === 0) === i);
  for (const version of versions) {
    const key = moves?.[version] ? version : keys.find((k) => compareVersions(k, version) === 0);
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
 * The repository's version tags, oldest first (sortTags: v0.11.0, v0.12.0, …).
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
 * A plan path's file: relative to the user folder (forward slashes, `../` for the workspaces' _skills beside it), or an
 * absolute one (_skills on another drive).
 * @param {string} userDir
 * @param {string} p
 */
function at(userDir, p) {
  return /^([A-Za-z]:)?\//.test(p) ? path.resolve(p) : path.join(userDir, ...p.split('/'));
}

/**
 * Where a plan path keeps its copies in the work folder (keep/, new/, merged/ …): inside it, also for a _skills path.
 * @param {string} p
 */
export const workRel = (p) => p.replace(/^(\.\.\/)+/, '').replace(/^([A-Za-z]):\//, '$1/').replace(/^\//, '');

/**
 * The user's place of a shipped common skill's file (`common-skills/<name>/<rest>` in the release): the copy in the
 * user's workspaces/_skills (src/workspace/common-skills.ts), as a plan path; null for any other path.
 * @param {string} userDir
 * @param {string} p
 */
export function skillsPlace(userDir, p) {
  if (!p.startsWith(`${SHIPPED_COMMON_SKILLS_DIR}/`)) return null;
  const file = path.join(commonSkillsDirOf(path.resolve(userDir)), ...p.slice(SHIPPED_COMMON_SKILLS_DIR.length + 1).split('/'));
  const rel = path.relative(path.resolve(userDir), file);
  return (path.isAbsolute(rel) ? file : rel).split(path.sep).join('/');
}

/** The _skills folder of a shipped common skill path is there (an install copied it; one not there yet is copied by finish).
 * @param {string} userDir
 * @param {string} p
 */
const skillFolderThere = (userDir, p) => fs.existsSync(path.join(commonSkillsDirOf(path.resolve(userDir)), p.split('/')[1]));

/**
 * @param {string} userDir
 * @param {string} p
 * @returns {Raw}
 */
function userRaw(userDir, p) {
  const f = at(userDir, p);
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
  const f = at(userDir, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

/**
 * Removes a file, and the folders it leaves empty (up to the user folder, never the user folder itself): a moved or
 * dropped skill's old folder without a SKILL.md would fail the skill format check, and empty old folders are clutter.
 * A folder that still holds anything (a file of the user's) stays.
 * @param {string} userDir
 * @param {string} p
 */
export function removeFile(userDir, p) {
  const root = path.resolve(userDir);
  const file = at(root, p);
  fs.rmSync(file, { force: true });
  for (let d = path.dirname(file); d.length > root.length && d.startsWith(root + path.sep); d = path.dirname(d)) {
    try {
      // A link (the .claude/skills junction) is never taken for an empty folder: removing it would not look at its target.
      if (fs.lstatSync(d).isSymbolicLink()) break;
      fs.rmdirSync(d);
    } catch {
      break;
    }
  }
}

/**
 * Removes a moved file's old place, unless it is the new file itself (the same file reached through a link).
 * @param {string} userDir
 * @param {string} from
 * @param {string} to
 */
function removeOld(userDir, from, to) {
  const [f, t] = [from, to].map((p) => at(userDir, p));
  try {
    if (fs.existsSync(t) && fs.realpathSync.native(f).toLowerCase() === fs.realpathSync.native(t).toLowerCase()) return;
  } catch {}
  removeFile(userDir, from);
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
  // The shipped common skills' copies in _skills, which an update may write too.
  const skills = commonSkillsDirOf(path.resolve(o.user));
  let k = 0;
  for (const name of fs.existsSync(path.join(o.user, SHIPPED_COMMON_SKILLS_DIR)) ? fs.readdirSync(path.join(o.user, SHIPPED_COMMON_SKILLS_DIR)) : []) {
    if (fs.existsSync(path.join(skills, name))) k += copyTree(path.join(skills, name), path.join(work, 'skills-files', name));
  }
  if (k) console.log(`공통 스킬 백업: ${work}\\skills-files (${skills}의 배포판 공통 스킬, 파일 ${k}개)`);
  console.log(`WORK=${work}`);
  // The user folder's older update skill runs this; the steps of this release are in the received repository's skill.
  const skill = path.join(HERE, SKILLS_DIR, 'secretary-update', 'SKILL.md');
  if (path.resolve(o.user) !== HERE && fs.existsSync(skill)) {
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
 * The version the user installed: the VERSION file. A folder without it (VERSION deleted), with a version no tag has, or
 * with one older than MIN_BASE is not guessed: the user is asked (CLEAR=no, no BASE).
 * @param {Options} opts
 */
function cmdDetect(opts) {
  const o = need(opts, 'user', 'repo');
  const { tags, latest } = load(o);
  const version = text(userRaw(o.user, 'VERSION'))?.trim();
  const list = readList(o.user);
  console.log(`최신: ${latest}`);
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
      // A shipped common skill: the user changes the copy in _skills.
      const place = skillsPlace(o.user, p);
      if (place && skillFolderThere(o.user, p)) {
        const mine = userRaw(o.user, place);
        if (mine === undefined) gone.push(place);
        else if (fileHash(mine) !== hash) changed.push(place);
      }
    }
    /** @param {string[]} xs */
    const some = (xs) => (xs.length ? ` (${xs.slice(0, 20).join(', ')}${xs.length > 20 ? ' 외' : ''})` : '');
    console.log(`파일 목록(${LIST_FILE}): ${list.version || '(버전 없음)'}, 목록 ${Object.keys(list.files).length}개 중 사용자가 고친 것 ${changed.length}개${some(changed)}, 지운 것 ${gone.length}개${some(gone)}`);
  } else console.log(`파일 목록(${LIST_FILE}): 없음 (tag 비교로만 찾는다)`);
  // Matched by number, so '0.11.0' finds tag v0.11.0.
  const tag = findTag(tags, version);
  if (tag && compareVersions(tag, MIN_BASE) >= 0) {
    console.log(`판별: ${tag} (VERSION 파일)`);
    console.log(`BASE=${tag}`);
    console.log('CLEAR=yes');
    return;
  }
  // Updates start from MIN_BASE; an older folder or a lost VERSION is the user's call.
  const why = !version ? 'VERSION 파일 없음' : parseVersion(version) && compareVersions(version, MIN_BASE) < 0 ? `VERSION 파일의 ${version}은 ${MIN_BASE}보다 옛 버전` : `VERSION 파일의 ${version}이 tag에 없음`;
  console.log(`판별: 못 함 (${why}). 이 업데이트는 ${MIN_BASE}부터 올린다: 사용자에게 받았던 버전을 묻고, ${MIN_BASE} 이상이면 그 tag를 --base로 준다(있는 tag: ${tags.join(', ')})`);
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
 * Each feature entry of a features.json text: its id and where its object starts and ends (strings skipped, so a brace or
 * an "id" in a description or in a scheduled task does not count).
 * @param {string} text
 * @returns {{ id: string, start: number, end: number }[]}
 */
export function featureSpans(text) {
  const at = text.search(/"features"\s*:\s*\[/);
  if (at < 0) return [];
  /** @type {{ id: string, start: number, end: number }[]} */
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let i = text.indexOf('[', at) + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[') {
      if (depth++ === 0 && c === '{') start = i;
    } else if (c === '}' || c === ']') {
      if (depth === 0) break;
      if (--depth === 0 && c === '}' && start >= 0) {
        /** @type {unknown} */
        let id;
        try {
          id = JSON.parse(text.slice(start, i + 1)).id;
        } catch {
          id = undefined;
        }
        if (typeof id === 'string') spans.push({ id, start, end: i + 1 });
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * What the user turned on or off in features.json stays the user's, whatever was chosen for the file (keep, new, a merge):
 * the other columns (description, files, checks …) follow the new version as settled. Reads the user's features.json from
 * before the update (<work>/files/features.json, the backup copy) and the installed version's (<work>/base/features.json,
 * written by apply): a feature whose "enabled" the user changed from the installed version gets the user's value back in the
 * user's features.json now; one the user left as shipped follows the new version. Only those "enabled" lines change; the
 * result is read back as JSON and left unwritten (with a line saying so) when it does not parse or a carried value is not
 * there. Returns lines for the output.
 * @param {string} userDir
 * @param {string} workDir
 */
export function carryFeatureStates(userDir, workDir) {
  /** @param {string} f */
  const read = (f) => {
    try {
      return normalize(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const oldText = read(path.join(workDir, 'files', 'features.json'));
  const file = path.join(userDir, 'features.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (oldText === null || raw === null) return [];
  /** @type {{ id?: string, enabled?: unknown }[]} */
  let old;
  try {
    old = JSON.parse(oldText).features ?? [];
  } catch {
    return [];
  }
  let text = raw;
  /** @type {string[]} */
  const lines = [];
  // The installed version's values (apply keeps a copy): a value the user never changed is the new version's to set.
  /** @type {Map<string, unknown> | null} */
  let shipped = null;
  try {
    const baseText = read(path.join(workDir, 'base', 'features.json'));
    if (baseText !== null) shipped = new Map((JSON.parse(baseText).features ?? []).map((/** @type {{ id?: string, enabled?: unknown }} */ f) => [f?.id, f?.enabled]));
  } catch {
    shipped = null;
  }
  /** @type {{ id: string, enabled: boolean }[]} */
  const want = [];
  for (const f of old) {
    if (!f || typeof f.id !== 'string' || typeof f.enabled !== 'boolean') continue;
    // As the installed version had it: not the user's choice (without the copy every value counts as the user's).
    if (shipped && shipped.get(f.id) === f.enabled) continue;
    const to = f.id;
    // Its "enabled" line, if it has one (a core feature has none, a dropped feature is gone).
    const span = featureSpans(text).find((s) => s.id === to);
    if (!span) continue;
    const entry = text.slice(span.start, span.end);
    const m = /"enabled"\s*:\s*(true|false)/.exec(entry);
    if (!m || m[1] === String(f.enabled)) continue;
    text = text.slice(0, span.start) + entry.replace(m[0], m[0].replace(m[1], String(f.enabled))) + text.slice(span.end);
    want.push({ id: to, enabled: f.enabled });
    lines.push(`${to}: "enabled": ${f.enabled} (사용자가 정해 둔 대로)`);
  }
  if (text === raw) return lines;
  // Read back: every carried value is there, and the file is still JSON.
  try {
    const now = JSON.parse(normalize(text)).features ?? [];
    for (const w of want) if (now.find((/** @type {{ id?: string }} */ f) => f?.id === w.id)?.enabled !== w.enabled) throw new Error(w.id);
  } catch (e) {
    return [`features.json을 고치지 못해 그대로 둠(${/** @type {Error} */ (e).message}): 사용자가 켜고 끈 값을 비서가 직접 맞춘다 — ${lines.join(', ')}`];
  }
  fs.writeFileSync(file, text);
  return lines;
}

/**
 * Every file of the base and newest versions with what to do about it.
 * @param {{ user: string, repo: string, base: string }} o
 */
function makePlan(o) {
  const { tags, latest } = load(o);
  // --base by number too: '0.11.0' and 'v0.11.0' are tag v0.11.0.
  const base = findTag(tags, o.base);
  if (!base) throw new Error(`없는 tag예요: ${o.base} (있는 것: ${tags.join(', ')})`);
  if (compareVersions(base, MIN_BASE) < 0) throw new Error(`${base}는 ${MIN_BASE}보다 옛 버전이라 이 업데이트로 올리지 않아요(${MIN_BASE}부터 올린다)`);
  // An optional feature's skill (src/setup/feature-skills.ts) is in .agents/skills while the user has the feature on and
  // in .agents/skills-off while off, whichever place the version ships it in. Its files are lined up under one name (the path under
  // .agents/skills) and read and written at the place the user's features.json gives (apply moves the folder there first).
  const skills = featureSkills(o.user);
  /** @param {string} p */
  const logical = (p) => featureSkillPath(p, skills)?.logical ?? p;
  /** @param {Map<string, Raw>} m */
  const lineUp = (m) => new Map([...m].map(([p, v]) => [logical(p), v]));
  const [baseFiles, newFiles] = versionFiles(o.repo, [base, latest]).map(lineUp);
  const moves = movesBetween(readMoves(o.repo, latest), tags, base, latest);
  // The user's file list: a file still matching its hash was not changed by the user, whatever the tag says.
  const listed = Object.fromEntries(Object.entries(readList(o.user)?.files ?? {}).map(([p, h]) => [logical(p), h]));
  /** The user's place for a lined-up path, and the user's file there (before apply moves it: at the other place). */
  /** @param {string} p */
  const userAt = (p) => {
    const at = featureSkillPath(p, skills);
    if (!at) return { path: p, raw: userRaw(o.user, p) };
    return { path: at.target, raw: userRaw(o.user, at.target) ?? userRaw(o.user, at.other) };
  };
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
    const { path: place, raw: u } = userAt(p);
    const t = newFiles.get(p);
    const shippedAt = skillsPlace(o.user, p);
    if (p === LIST_FILE || shippedAt) {
      // The list describes the version in the folder, and a shipped common skill in the secretary folder is only what an
      // install copies from: always the new version's, never a question.
      items.push({ path: p, action: t === undefined ? (u === undefined ? 'same' : 'delete') : u !== undefined && text(u) === text(t) ? 'same' : u === undefined ? 'add' : 'replace', base: baseFiles.get(p), user: u, theirs: t });
      // The user's copy in _skills, held to the installed version like a secretary file (a skill not copied there yet: finish copies it).
      if (shippedAt && skillFolderThere(o.user, p)) {
        const mine = userRaw(o.user, shippedAt);
        const { base: b, byList } = baseFor(baseFiles.get(p), mine, listed[p]);
        let action = classify(text(b), text(mine), text(t));
        if (action === 'merge' && [b, mine, t].some(isBinary)) action = 'ask-binary';
        items.push({ path: shippedAt, action, base: b, user: mine, theirs: t, ...(byList ? { byList } : {}) });
      }
      continue;
    }
    const { base: b, byList } = baseFor(baseFiles.get(p), u, listed[p]);
    let action = classify(text(b), text(u), text(t));
    if (action === 'merge' && [b, u, t].some(isBinary)) action = 'ask-binary';
    items.push({ path: place, action, base: b, user: u, theirs: t, ...(byList ? { byList } : {}) });
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
  console.log(`기준 ${base} → 최신 ${latest}`);
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
  /** A JSON file whose clashing lines were merged by key: that merge, or a side of the line clash. */
  keyed: ['keep', 'new', 'merge', 'merge-mine', 'merge-new', 'edited'],
  ask: ['keep', 'new'],
};

/** The files that say which version the folder is: written last, once every question is settled (writeVersionMarks). */
export const VERSION_MARKS = ['VERSION', LIST_FILE];
/** Where apply keeps the new version's VERSION and file list until then. */
const LATER_DIR = 'version-files';

/**
 * Writes the waiting version marks (status 'later') once nothing is left to ask: the new version's copy kept in the work
 * folder, or none (the new version dropped it). Returns the paths written, [] while a question is open.
 * @param {{ user: string, work: string }} o
 * @param {{ results: Result[] }} state
 */
export function writeVersionMarks(o, state) {
  if (state.results.some(isOpen)) return [];
  /** @type {string[]} */
  const done = [];
  for (const r of state.results.filter((x) => x.status === 'later')) {
    const kept = path.join(o.work, LATER_DIR, ...workRel(r.path).split('/'));
    if (fs.existsSync(kept)) writeFile(o.user, r.path, fs.readFileSync(kept));
    else removeFile(o.user, r.path);
    r.status = 'done';
    done.push(r.path);
  }
  return done;
}

/** @param {Options} opts */
function cmdApply(opts) {
  const o = need(opts, 'user', 'repo', 'base', 'work');
  if (!fs.existsSync(path.join(o.work, 'files'))) throw new Error(`백업 사본이 없어요. backup을 먼저 돌리세요: ${o.work}`);
  // An optional feature's skill to the place the user's features.json gives it before anything is written: the folder
  // moves whole, with what the user changed.
  const placedBefore = fixFeatureSkills(o.user);
  const { base, latest, items } = makePlan(o);
  printPlan(latest, base, items);
  const pkgBefore = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  /** @type {Result[]} */
  const results = [];
  /** @type {(dir: string, p: string, data: string | Buffer) => string} */
  const keepCopy = (dir, p, data) => {
    const f = path.join(o.work, dir, ...workRel(p).split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    return f;
  };
  for (const i of items) {
    /** @type {Result} */
    const r = { path: i.path, ...(i.from ? { from: i.from } : {}), action: i.action, status: 'done' };
    // The installed version's features.json: what the user turned on or off is told from it (carryFeatureStates).
    if (i.path === 'features.json' && i.base !== undefined) keepCopy('base', i.path, i.base);
    /** @param {string} t */
    const style = (t) => restyle(t, i.user?.toString('utf8'), i.theirs?.toString('utf8'));
    // replace, add and move have the new version's file, move-keep the user's, and a move its old path (makePlan).
    if (VERSION_MARKS.includes(i.path) && ['replace', 'add', 'delete'].includes(i.action)) {
      // The version marks wait for the rest: written now, an update stopped before every question is settled would leave
      // the folder saying it is the new version, and the next update would take the unsettled old files for the user's own changes.
      r.status = 'later';
      if (i.theirs !== undefined) keepCopy(LATER_DIR, i.path, i.theirs);
    } else if (i.action === 'replace' || i.action === 'add') writeFile(o.user, i.path, /** @type {Buffer} */ (i.theirs));
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
        // A settings JSON whose lines clash (or whose clean line merge is no JSON): merged by key instead, both sides' entries kept.
        const byKeys = keyMerged(i.path) && (m.conflicts > 0 || !readsAsJson(m.text)) ? mergeJsonText(i.path, b, u, t) : null;
        if (m.conflicts === 0 && !byKeys) {
          // Also the starting point for a hand-made mix (edited).
          r.side = keepCopy('merged', i.path, style(m.text));
          r.choices = CHOICES.merge;
        } else if (byKeys) {
          r.side = keepCopy('merged', i.path, style(byKeys.text));
          r.byKeys = true;
          r.keyClashes = byKeys.clashes;
          if (m.conflicts) {
            keepCopy('merged-mine', i.path, style(merge3(b, u, t, 'ours').text));
            keepCopy('merged-new', i.path, style(merge3(b, u, t, 'theirs').text));
          }
          r.choices = m.conflicts ? CHOICES.keyed : CHOICES.merge;
        } else {
          r.side = keepCopy('conflicts', i.path, style(m.text));
          keepCopy('merged-mine', i.path, style(merge3(b, u, t, 'ours').text));
          keepCopy('merged-new', i.path, style(merge3(b, u, t, 'theirs').text));
          r.choices = CHOICES.conflict;
        }
      }
      r.recommend = recommend(i.action, i.path, r.conflicts ?? 0, r.byKeys ?? false);
    } else r.status = 'none';
    results.push(r);
  }
  const pkgAfter = ['package.json', 'package-lock.json'].map((p) => text(userRaw(o.user, p)));
  const secretaryId = ensureId(o.user);
  // Skill links (.claude/skills → .agents/skills, the .gitignore lines) put right in this same command, so the CLI never
  // finds a skill folder missing between two commands (the session running this update follows the received
  // repository's update skill by its path, which does not move).
  const links = fixSkillLinks(o.user);
  // Again after the files: the new features.json may ship a feature off that had a skill in .agents/skills.
  const placedAfter = fixFeatureSkills(o.user);
  const featureSkillLines = [...formatFeatureSkills(placedBefore.plan, true), ...formatFeatureSkills(placedAfter.plan, true), ...placedBefore.failed, ...placedAfter.failed];
  // What the user turned on or off in features.json stays (written now; resolve does it again for one settled later).
  const featureIds = carryFeatureStates(o.user, o.work);
  const state = { base, latest, packageChanged: pkgBefore.some((x, k) => x !== pkgAfter[k]), secretaryId, skills: { links, featureSkills: featureSkillLines }, featureIds, results };
  const marks = writeVersionMarks(o, state);
  fs.writeFileSync(path.join(o.work, 'update.json'), JSON.stringify(state, null, 1));
  console.log('');
  console.log(`적용함: ${results.filter((r) => r.status === 'done').length}개`);
  printMarks(marks, state);
  console.log(`package.json 바뀜: ${state.packageChanged ? '예 (npm install 필요)' : '아니요'}`);
  console.log(
    secretaryId.created
      ? `비서 고유 번호: ${secretaryId.id} (새로 만듦, ${ID_FILE})`
      : `비서 고유 번호: ${secretaryId.id} (그대로, ${ID_FILE})`,
  );
  printSkills(links);
  for (const line of featureSkillLines) console.log(`선택 기능 스킬 자리: ${line}`);
  for (const line of featureIds) console.log(`기능 목록(features.json): ${line}`);
  printOpen(state);
}

/** @param {LinkFix} links */
function printSkills(links) {
  for (const line of formatSkillLinkFix(links, false)) console.log(line);
  if (links.failed.length || links.kept.length) console.log('  → 업데이트를 마친 뒤 사용자 폴더에서 `node src/cli.ts skill-links`로 다시 만든다(설치 상태 점검 항목 skills가 알린다)');
}

/** @param {Result} r */
const isOpen = (r) => r.status === 'ask';

/**
 * The version marks' line: written now, or still waiting for the open questions.
 * @param {string[]} written
 * @param {{ results: Result[] }} state
 */
function printMarks(written, state) {
  const waiting = state.results.filter((r) => r.status === 'later').map((r) => r.path);
  if (written.length) console.log(`버전 표시 파일(남은 부딪힘 없음, 새 버전으로 씀): ${written.join(', ')}`);
  if (waiting.length) console.log(`버전 표시 파일(남은 부딪힘을 모두 정한 뒤 resolve가 새 버전으로 씀, 그 전에 그만두면 다음 업데이트도 옛 버전에서 올린다): ${waiting.join(', ')}`);
}

/** @param {{ results: Result[] }} state */
function printOpen(state) {
  const open = state.results.filter(isOpen);
  if (!open.length) {
    console.log('남은 부딪힘: 없음');
    return;
  }
  console.log(`남은 부딪힘: ${open.length}개 (파일마다 사용자에게 물어볼 것, 그동안 사용자 파일은 그대로)`);
  for (const r of open) {
    const how = r.byKeys
      ? ` (${r.conflicts ? `줄로는 부딪힌 곳 ${r.conflicts}군데, ` : ''}JSON 키 단위로 합침: 양쪽이 더한 항목 모두 살림${r.keyClashes?.length ? `, 둘 다 바꾼 값 ${r.keyClashes.length}곳은 ${NEW_VALUE_WINS.test(r.path) ? '새 버전' : '사용자'} 값으로 둠: ${r.keyClashes.join(', ')}` : ''})`
      : r.conflicts
        ? ` (부딪힌 곳 ${r.conflicts}군데)`
        : ' (깨끗이 합쳐짐)';
    const merged = r.side ? ` · 합친 안: ${r.side}${how}` : '';
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
  const copy = (dir) => path.join(o.work, dir, ...workRel(r.path).split('/'));
  /** @param {string} dir */
  const has = (dir) => fs.existsSync(copy(dir));
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
  if (r.path === 'features.json') for (const line of carryFeatureStates(o.user, o.work)) console.log(`기능 목록(features.json): ${line}`);
}

/** @param {Options} opts */
function cmdResolve(opts) {
  const o = need(opts, 'user', 'work');
  const one = o.rest ? null : need(o, 'file', 'take');
  const stateFile = path.join(o.work, 'update.json');
  /** @type {{ results: Result[] }} */
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
  const marks = writeVersionMarks(o, state);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  const left = state.results.filter(isOpen).map((x) => x.path);
  console.log(`남은 부딪힘: ${left.length ? left.join(', ') : '없음'}`);
  printMarks(marks, state);
}

/**
 * After the files are settled and npm install has run: what a person used to do after an update, done by the program
 * (v0.11.0). Only what needs no choice is done; what does is listed for the secretary to ask about.
 * - The workspaces: the user's own `node src/cli.ts workspace-links` (the new code, the user's database) puts each
 *   workspace's rules and links right; one it could not fix ("못 고침") is listed ("물어볼 공간").
 * Safe to run again. Exit 1 when a step failed.
 * @param {Options} opts
 */
function cmdFinish(opts) {
  const o = need(opts, 'user');
  /** @type {string[]} */
  let lines = [];
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', path.join('src', 'cli.ts'), 'workspace-links'], { cwd: o.user, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    lines = out.split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines) console.log(`작업 공간(workspace-links): ${l}`);
  } catch (e) {
    const err = /** @type {{ stdout?: string, stderr?: string, message: string }} */ (e);
    for (const l of `${err.stdout ?? ''}`.split(/\r?\n/).filter((x) => x.trim())) console.log(`작업 공간(workspace-links): ${l}`);
    const first = `${err.stderr ?? ''}`.split(/\r?\n/).find((x) => x.trim()) ?? err.message;
    console.log(`작업 공간(workspace-links): 실패 — ${first} (사용자 폴더에서 \`node src/cli.ts workspace-links\`를 다시 돌려 출력을 본다)`);
    process.exitCode = 1;
  }
  const askWorkspaces = lines.filter((l) => l.startsWith('못 고침: ')).map((l) => l.slice('못 고침: '.length));
  console.log(`물어볼 공간(workspace-links가 못 고침): ${askWorkspaces.length ? '' : '없음'}`);
  for (const w of askWorkspaces) console.log(`  - ${w}`);
  console.log(`ASK_WORKSPACES=${askWorkspaces.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /** @type {Record<string, (o: Options) => void>} */
  const cmds = { backup: cmdBackup, detect: cmdDetect, plan: cmdPlan, apply: cmdApply, resolve: cmdResolve, finish: cmdFinish };
  const cmd = cmds[process.argv[2]];
  try {
    if (!cmd) throw new Error('usage: node scripts/update.mjs backup|detect|plan|apply|resolve|finish --user <비서 폴더> [--repo <받은 저장소>] [--base <tag>] [--work <백업 폴더>] [--file <경로> --take <고른 것> | --rest]');
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
