/**
 * Common skills: skills several workspaces share (brand-free tool knowledge, with the code, settings and data they use
 * in their scripts/, references/, assets/) live once in workspaces/_skills/common-<name>/. The common- prefix is part
 * of the folder name and of the skill's `name` (agentskills.io: name = folder name), so one name is used everywhere: in
 * the list, in the link, in the folder and in the skill, and it never meets a folder's own skill (whose names must not
 * start with common-). A folder (a workspace, or the secretary's own) lists the ones it uses in `common-skills.json` at
 * its top (in its git, so a workspace release carries the list), and this module makes what each CLI needs from it:
 * - Claude Code and Codex: a link `.agents/skills/<name>` to _skills/<name> (Claude Code reads it through
 *   .claude/skills, which is a link to .agents/skills: setup/skill-links.ts). Links differ per PC (a junction holds an
 *   absolute path), so they stay out of git (.gitignore, setup/skill-links.ts SKILL_GITIGNORE_LINES).
 * - Antigravity, which reads only real folders in .agents/skills: `.agents/skills.json` with one entry for _skills and
 *   the listed names (include_only). The path is absolute: agy 1.5.2 refuses a relative path that leaves the folder
 *   ("escapes workspace root") even with that folder added, and reads an absolute one once the folder is added to the
 *   session (run-job adds it: scripts/run-job/run-job-other-cli.ps1 --add-dir; tried 2026-11-07). An absolute path differs
 *   per PC, so the file stays out of git like the links; a relative entry from before is taken as ours and rewritten.
 *   Other entries in that file (the user or the secretary wrote them) are kept.
 *
 * The old form (before 2026-11-09): names listed without the prefix, folders _skills/<name>/ and links common-<name>.
 * A name without the prefix is read as common-<name> and the list is written again with the prefix; a common skill
 * still in its old folder (_skills/<name>/, no _skills/common-<name>/) is moved to the new one and its SKILL.md name
 * set, so a release's user moves over by the same fix.
 *
 * Only links named common-* are this module's: a common-* link to something not on the list is removed, a real folder
 * there is reported and left. A link in .agents/skills under another name that points at a common skill (the user or the secretary made it
 * before this list) is taken onto the list and replaced by its common-* link. Run with the skill layout fix
 * (workspace/secretary-link.ts writeLink for workspaces, `node src/cli.ts skill-links` for the secretary).
 */
import fs from 'node:fs';
import path from 'node:path';
import { cutLink, makeDirLink, SKILLS_DIR } from '../setup/skill-links.ts';

export const COMMON_SKILLS_FILE = 'common-skills.json';
export const COMMON_PREFIX = 'common-';
/** Where the common skills are, in the workspaces folder. */
export const COMMON_SKILLS_DIR = '_skills';
/** The about line a new common-skills.json gets. */
export const COMMON_SKILLS_ABOUT =
  '이 공간이 쓰는 공통 스킬(workspaces/_skills/common-<이름>) 목록. 이름은 common-까지 적는다(폴더 이름 = 스킬 name). 비서가 이 목록대로 .agents/skills에 같은 이름의 연결(Claude Code·Codex가 읽는다)과 .agents/skills.json(Antigravity가 읽는다)을 만든다(node src/cli.ts workspace-links). 고칠 때는 비서에게 말한다.';
/**
 * About lines the secretary wrote before (the list's form changed 2026-11-09: names with common-): a list with one of
 * them gets the current line from the same fix. An about the user wrote is left.
 */
export const OLD_COMMON_SKILLS_ABOUTS = [ // legacy-name: common-skill-prefix
  '이 공간이 쓰는 공통 스킬(workspaces/_skills) 목록. 비서가 이 목록대로 .agents/skills에 common-<이름> 연결(Claude Code·Codex가 읽는다)과 .agents/skills.json(Antigravity가 읽는다)을 만든다(node src/cli.ts workspace-links). 고칠 때는 비서에게 말한다.',
];
/** Antigravity's list of extra skill folders (per PC, out of git). */
export const AGY_SKILLS_FILE = '.agents/skills.json';

const norm = (p: string) => {
  const r = path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const real = (p: string): string | null => {
  try {
    return norm(fs.realpathSync.native(p));
  } catch {
    return null;
  }
};
/** A name as listed: with the prefix, or the old form without it. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A listed name in the current form (old ones gain the prefix). */
export const withPrefix = (n: string) => (n.startsWith(COMMON_PREFIX) ? n : `${COMMON_PREFIX}${n}`);

/** The raw names in the list (as written); null when there is no list, 'bad' when it cannot be read. */
function readRawList(folder: string): string[] | null | 'bad' {
  const file = path.join(folder, COMMON_SKILLS_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const names = v?.skills;
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && NAME.test(n))) return 'bad';
    return names as string[];
  } catch {
    return 'bad';
  }
}

/** The list's about line (null: none, or the file cannot be read). */
function readAbout(folder: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(folder, COMMON_SKILLS_FILE), 'utf8').replace(/^﻿/, ''));
    return typeof v?.about === 'string' ? v.about : null;
  } catch {
    return null;
  }
}

/** The names a folder lists, with the prefix; null when it has no list (nothing to link), 'bad' when the file cannot be read. */
export function readCommonSkills(folder: string): string[] | null | 'bad' {
  const raw = readRawList(folder);
  return raw === null || raw === 'bad' ? raw : [...new Set(raw.map(withPrefix))].sort();
}

/** Sets the name: line of a SKILL.md's front matter (the old common skill moved to its common- folder). */
function setSkillName(file: string, name: string): void {
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^(﻿?---\r?\n[\s\S]*?^name:[ \t]*)[^\r\n]*/m, `$1${name}`);
  if (next !== text) fs.writeFileSync(file, next);
}

interface AgyEntry {
  path?: string;
  include_only?: string[];
  [k: string]: unknown;
}
interface AgyFile {
  entries?: AgyEntry[];
  [k: string]: unknown;
}

/** .agents/skills.json's path for commonDir: absolute, forward slashes (agy refuses a relative one outside the folder). */
export const agyPathFor = (_folder: string, commonDir: string) => path.resolve(commonDir).split(path.sep).join('/');

function readAgy(folder: string): AgyFile | 'bad' | null {
  const file = path.join(folder, ...AGY_SKILLS_FILE.split('/'));
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) && (v.entries === undefined || Array.isArray(v.entries)) ? v : 'bad';
  } catch {
    return 'bad';
  }
}

/** The file's text with our entry set to names (none: taken out); null when the file should not be there. */
function agyText(folder: string, commonDir: string, names: string[], now: AgyFile | null): string | null {
  const ours = (e: AgyEntry) => typeof e?.path === 'string' && norm(path.resolve(folder, e.path)) === norm(commonDir);
  const others = (now?.entries ?? []).filter((e) => !ours(e));
  const entries = names.length ? [...others, { path: agyPathFor(folder, commonDir), include_only: names }] : others;
  const rest = Object.fromEntries(Object.entries(now ?? {}).filter(([k]) => k !== 'entries'));
  if (!entries.length && !Object.keys(rest).length) return null;
  return `${JSON.stringify({ ...rest, entries }, null, 2)}\n`;
}

interface Plan {
  /** Common skills still in their old folder (_skills/<name>/): moved to _skills/common-<name>/, SKILL.md name set. */
  rename: { from: string; to: string }[];
  /** The list is in the old form (a name without the prefix): written again with it. */
  relist: boolean;
  /** The list's about is one the secretary wrote before: written again with the current one. */
  staleAbout: boolean;
  /** Links to make or make again: rel (forward slashes) → target folder. */
  make: { rel: string; target: string; wrong: boolean }[];
  /** common-* links not on the list (or to a skill gone). */
  remove: string[];
  /** Hand-made links to a common skill under another name: taken onto the list, then removed. */
  adopt: { rel: string; name: string }[];
  /** Real folders or files where a link belongs: left. */
  kept: string[];
  /** Listed names with no _skills/<name>/SKILL.md. */
  unknown: string[];
  /** The names that get links, after adopting. */
  names: string[];
  /** .agents/skills.json's text to write (null: remove it); undefined when it is right. */
  agy?: string | null;
  /** common-skills.json or .agents/skills.json cannot be read. */
  bad: string[];
  /** The folder's own skills (real folders) named common-*: that name is the common skills'. */
  clash: string[];
}

/** Whether _skills holds the skill: in its folder, or (planned) moved there from the old one. */
const hasSkill = (commonDir: string, n: string, rename: Plan['rename']) =>
  fs.existsSync(path.join(commonDir, n, 'SKILL.md')) || rename.some((r) => r.to === n);

function plan(folder: string, commonDir: string): Plan {
  const p: Plan = { rename: [], relist: false, staleAbout: false, make: [], remove: [], adopt: [], kept: [], unknown: [], names: [], bad: [], clash: [] };
  const raw = readRawList(folder);
  if (raw === 'bad') {
    p.bad.push(COMMON_SKILLS_FILE);
    return p;
  }
  const listed = raw === null ? null : [...new Set(raw.map(withPrefix))].sort();
  p.relist = !!raw?.some((n) => !n.startsWith(COMMON_PREFIX));
  p.staleAbout = raw !== null && OLD_COMMON_SKILLS_ABOUTS.includes(readAbout(folder) ?? '');
  const dir = path.join(folder, ...SKILLS_DIR.split('/'));
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  // A hand-made link to _skills/<name> under another name: onto the list, replaced by its common- link.
  const commonReal = real(commonDir);
  if (commonReal) {
    for (const e of entries) {
      if (e.name.startsWith(COMMON_PREFIX) || !e.isSymbolicLink()) continue;
      const t = real(path.join(dir, e.name));
      if (t && path.dirname(t) === commonReal && fs.existsSync(path.join(t, 'SKILL.md'))) p.adopt.push({ rel: `${SKILLS_DIR}/${e.name}`, name: withPrefix(path.basename(t)) });
    }
  }
  const all = [...new Set([...(listed ?? []), ...p.adopt.map((a) => a.name)])].sort();
  // The old folder of a listed skill (no common- folder yet): moved.
  for (const n of all) {
    const old = n.slice(COMMON_PREFIX.length);
    if (!fs.existsSync(path.join(commonDir, n)) && fs.existsSync(path.join(commonDir, old, 'SKILL.md'))) p.rename.push({ from: old, to: n });
  }
  p.names = all.filter((n) => {
    const ok = hasSkill(commonDir, n, p.rename);
    if (!ok) p.unknown.push(n);
    return ok;
  });
  for (const n of p.names) {
    const rel = `${SKILLS_DIR}/${n}`;
    const at = path.join(folder, ...rel.split('/'));
    const target = path.join(commonDir, n);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(at);
    } catch {}
    if (!st) p.make.push({ rel, target, wrong: false });
    else if (st.isSymbolicLink()) {
      if (real(at) === null || real(at) !== real(target)) p.make.push({ rel, target, wrong: true });
    } else p.kept.push(rel);
  }
  for (const e of entries) {
    if (!e.name.startsWith(COMMON_PREFIX) || !e.isSymbolicLink()) continue;
    if (!p.names.includes(e.name)) p.remove.push(`${SKILLS_DIR}/${e.name}`);
  }
  for (const e of entries) if (e.isDirectory() && e.name.startsWith(COMMON_PREFIX) && !p.names.includes(e.name)) p.clash.push(`${SKILLS_DIR}/${e.name}`);
  const agy = readAgy(folder);
  if (agy === 'bad') p.bad.push(AGY_SKILLS_FILE);
  else {
    const want = agyText(folder, commonDir, p.names, agy);
    const file = path.join(folder, ...AGY_SKILLS_FILE.split('/'));
    const have = agy === null ? null : fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const same = want === null ? have === null : have !== null && JSON.stringify(JSON.parse(have)) === JSON.stringify(JSON.parse(want));
    if (!same) p.agy = want;
  }
  return p;
}

/** Why the folder's common skills are not right; null when they are. */
export function commonSkillProblem(folder: string, commonDir: string): string | null {
  const p = plan(folder, commonDir);
  const out: string[] = [];
  if (p.bad.length) out.push(`${p.bad.join(', ')}을 못 읽음`);
  if (p.relist) out.push(`${COMMON_SKILLS_FILE}이 옛 형식(이름에 ${COMMON_PREFIX} 없음)`);
  if (p.staleAbout) out.push(`${COMMON_SKILLS_FILE}의 about이 옛 설명`);
  if (p.rename.length) out.push(`옛 이름 폴더의 공통 스킬(${COMMON_PREFIX}을 붙여 옮김): ${p.rename.map((r) => `${COMMON_SKILLS_DIR}/${r.from}`).join(', ')}`);
  if (p.unknown.length) out.push(`공통 스킬 없음: ${p.unknown.join(', ')}`);
  if (p.adopt.length) out.push(`목록에 넣을 공통 스킬 연결: ${p.adopt.map((a) => a.rel).join(', ')}`);
  if (p.make.length) out.push(`공통 스킬 연결 없음·틀림: ${p.make.map((m) => m.rel).join(', ')}`);
  if (p.remove.length) out.push(`목록에 없는 공통 스킬 연결: ${p.remove.join(', ')}`);
  if (p.kept.length) out.push(`연결 대신 실제 폴더(지우지 않음): ${p.kept.join(', ')}`);
  if (p.agy !== undefined) out.push(`${AGY_SKILLS_FILE}이 목록과 다름`);
  if (p.clash.length) out.push(`이름이 ${COMMON_PREFIX}으로 시작하는 공간 스킬(공통 스킬 이름 자리라 공간 스킬 이름을 바꾼다): ${p.clash.join(', ')}`);
  return out.length ? out.join('; ') : null;
}

/** Makes the folder's common skills right: old folders, the list (old form, adopted links), the links, .agents/skills.json. Real folders and unknown names are left. */
export function fixCommonSkills(folder: string, commonDir: string): boolean {
  const p = plan(folder, commonDir);
  if (p.bad.includes(COMMON_SKILLS_FILE)) return false;
  let changed = false;
  for (const r of p.rename) {
    fs.renameSync(path.join(commonDir, r.from), path.join(commonDir, r.to));
    setSkillName(path.join(commonDir, r.to, 'SKILL.md'), r.to);
    changed = true;
  }
  if (p.adopt.length || p.relist || p.staleAbout) {
    const file = path.join(folder, COMMON_SKILLS_FILE);
    const read = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : { about: COMMON_SKILLS_ABOUT };
    const now = p.staleAbout ? { ...read, about: COMMON_SKILLS_ABOUT } : read;
    const before: string[] = now.skills ?? [];
    const names = [...new Set([...before.map(withPrefix), ...p.adopt.map((a) => a.name)])].sort();
    // Written only when a name is new or in the old form (an already listed one only loses its hand-made link).
    if (p.relist || p.staleAbout || names.length !== before.length || !fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ ...now, skills: names }, null, 2)}\n`);
    for (const a of p.adopt) cutLink(path.join(folder, ...a.rel.split('/')));
    changed = true;
  }
  for (const rel of p.remove) {
    cutLink(path.join(folder, ...rel.split('/')));
    changed = true;
  }
  for (const m of p.make) {
    const at = path.join(folder, ...m.rel.split('/'));
    if (m.wrong) cutLink(at);
    makeDirLink(at, m.target);
    changed = true;
  }
  if (p.agy !== undefined) {
    const file = path.join(folder, ...AGY_SKILLS_FILE.split('/'));
    if (p.agy === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, p.agy);
    }
    changed = true;
  }
  return changed;
}
