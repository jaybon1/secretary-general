/**
 * The skill format check (agentskills.io/specification, read 2026-11-09): every real skill folder (not a link: Ego
 * Lite's ego-browser and the common-* links are another's to keep) in the secretary's .agents/skills, in each
 * workspace's and in the common skills (workspaces/_skills) holds SKILL.md with front matter whose `name` is the
 * folder's name (lowercase letters, digits, single hyphens, at most 64) and whose `description` says what and when (at
 * most 1024 characters), under 500 lines. Next to SKILL.md only scripts/ (code), references/ (documents) and assets/
 * (templates, settings, data): a reference file loose at the top goes to references/. A workspace's own skill is not
 * named common-* (the common skills' names, workspace/common-skills.ts).
 *
 * Read by the install check ('skills' for the secretary and _skills, 'workspace-links' for workspaces) and by npm test
 * (the skills in this repository). Kept free of the rest of src/ (only node: imports), like setup/skill-links.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

/** What the format allows in the front matter. */
export const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
/** What the format allows next to SKILL.md. */
export const SPEC_DIRS = ['scripts', 'references', 'assets'];
/**
 * Front matter keys outside the format that a skill keeps on purpose (skill folder name → keys, each with its reason
 * here). One place only; empty now. A skill of a feature that is off no longer carries disable-model-invocation: it is
 * kept out of .agents/skills instead (setup/feature-skills.ts, 2026-11-09). The list stays so a new exception has one
 * place to go (the install check's fix text names it).
 */
export const SPEC_KEY_EXCEPTIONS: Record<string, string[]> = {};
export const MAX_LINES = 500;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Left alone next to SKILL.md: a cache a tool makes and an editor's or OS's files. */
const IGNORED = new Set(['__pycache__', '.DS_Store', 'Thumbs.db', '.gitignore']);

/** The front matter's top-level keys and plain values (a folded or block value is kept as its first line). */
export function frontMatter(text: string): Map<string, string> | null {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return null;
  const out = new Map<string, string>();
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!k) continue;
    let v = k[2].trim();
    // A block (| or >) or a value on the next indented lines: joined.
    if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') {
      const more: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      v = more.join(' ');
    }
    out.set(k[1], v.replace(/^(['"])([\s\S]*)\1$/, '$2'));
  }
  return out;
}

/** What is wrong with one skill folder against the format; [] when nothing. own: a folder's own skill (not common). */
export function skillSpecProblems(dir: string, { own = false } = {}): string[] {
  const folder = path.basename(dir);
  const out: string[] = [];
  const file = path.join(dir, 'SKILL.md');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return ['SKILL.md 없음'];
  }
  const fm = frontMatter(text);
  if (!fm) out.push('머리말(`--- … ---`) 없음');
  else {
    const name = fm.get('name');
    if (!name) out.push('name 없음');
    else {
      if (name !== folder) out.push(`name(${name})이 폴더 이름과 다름`);
      if (!NAME.test(name) || name.length > 64) out.push(`name(${name})이 소문자·숫자·하이픈 64자 형식이 아님`);
    }
    const desc = fm.get('description') ?? '';
    if (!desc) out.push('description 없음');
    else if (desc.length > 1024) out.push(`description ${desc.length}자(1024자 넘음)`);
    const comp = fm.get('compatibility');
    if (comp !== undefined && comp.length > 500) out.push(`compatibility ${comp.length}자(500자 넘음)`);
    const allowed = new Set([...SPEC_KEYS, ...(SPEC_KEY_EXCEPTIONS[folder] ?? [])]);
    const extra = [...fm.keys()].filter((k) => !allowed.has(k));
    if (extra.length) out.push(`사양에 없는 머리말 키: ${extra.join(', ')}(metadata 아래로)`);
  }
  const lines = text.split(/\n/).length;
  if (lines >= MAX_LINES) out.push(`SKILL.md ${lines}줄(${MAX_LINES}줄 미만으로, 세부는 references/로)`);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  const loose = entries.filter((e) => e.name !== 'SKILL.md' && !IGNORED.has(e.name) && !(e.isDirectory() && SPEC_DIRS.includes(e.name))).map((e) => e.name);
  if (loose.length) out.push(`SKILL.md 옆에 scripts/·references/·assets/ 밖의 것: ${loose.join(', ')}`);
  if (own && folder.startsWith('common-')) out.push('공간 스킬 이름이 common-으로 시작함(공통 스킬에만 쓰는 이름)');
  return out;
}

/** Every real skill folder in dir (links are skipped), with what is wrong; only the ones with problems. */
export function skillsDirProblems(dir: string, opts: { own?: boolean } = {}): { skill: string; problems: string[] }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const problems = skillSpecProblems(path.join(dir, e.name), opts);
      return problems.length ? [{ skill: e.name, problems }] : [];
    });
}

/** The problems as one line for the install check; null when none. */
export const formatSpecProblems = (label: string, list: { skill: string; problems: string[] }[]): string | null =>
  list.length ? `${label} 스킬 사양(agentskills.io)과 다름: ${list.map((x) => `${x.skill}(${x.problems.join(', ')})`).join('; ')}` : null;
