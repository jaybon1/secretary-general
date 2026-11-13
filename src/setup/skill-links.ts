/**
 * Where skills live, the same in the secretary folder and in every workspace: the real skill folders are
 * .agents/skills/<name>/ (in git, and in a release), where Codex and Antigravity read them (their docs). Claude Code reads
 * .claude/skills/, which is one link to .agents/skills: a Windows directory junction (no administrator needed), a
 * symbolic link elsewhere. Besides the real folders, .agents/skills holds links another program or the secretary makes
 * (Ego Lite's ego-browser, common-<name> to the shared workspaces/_skills, workspace/common-skills.ts). Links are never in
 * git or a release (.gitignore; a zip cannot hold a junction), so a fresh clone, a release and an update leave
 * .claude/skills to `node src/cli.ts skill-links` (install check item 'skills'; for a workspace, `workspace-links`).
 *
 * The same fix moves the old layouts over: skills/<name>/ (the secretary up to v8, workspaces before) with links to it
 * in .claude/skills and .agents/skills, and a real .claude/skills folder of links (common-*, hand-made ones). Such links
 * are dropped, skill folders move to .agents/skills, and a link elsewhere moves as a link with the same target. A real
 * folder that meets one of the same name is never removed or merged: it is reported. Only an empty folder is replaced.
 *
 * Kept free of the rest of src/ (only node: imports): the release's scripts/update.mjs imports it from the new version
 * to put the skills right at the end of an update, before the user's packages are reinstalled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SECRETARY_SKILLS_DIR } from '../core/paths.ts';

/** Where the skills really are, relative to the folder (Codex and Antigravity read them here); kept in core/paths.ts, which core reads without setup. */
export const SKILLS_DIR = SECRETARY_SKILLS_DIR;
/** Where Claude Code reads skills: one link to SKILLS_DIR. */
export const CLAUDE_SKILLS_DIR = '.claude/skills';
/** The old place of the real skill folders (the secretary up to v8, workspaces before): moved into SKILLS_DIR. */
export const OLD_SKILLS_DIR = 'skills'; // legacy-name: old-skills-layout
/** The folders the CLIs read skills from: Claude Code, then Codex and Antigravity. */
export const SKILL_LINK_DIRS = [CLAUDE_SKILLS_DIR, SKILLS_DIR] as const;
/**
 * .gitignore lines for the links: Claude Code's folder, the common-* links, and Antigravity's list of the common skills
 * (absolute path, workspace/common-skills.ts). A workspace gets them from the fix; the secretary's own .gitignore
 * carries them.
 */
export const SKILL_GITIGNORE_LINES = [
  '# 스킬 링크(비서가 만든다, PC마다 다르다): .claude/skills는 .agents/skills로, .agents/skills/common-*는 공통 스킬(workspaces/_skills)로 가는 링크(정션), .agents/skills.json은 Antigravity용 공통 스킬 목록(절대 경로)',
  `/${CLAUDE_SKILLS_DIR}`,
  `/${SKILLS_DIR}/common-*`,
  `/${SKILLS_DIR}.json`,
];
/**
 * How the header line SKILL_GITIGNORE_LINES[0] began until 2026-11-11 (it said 연결 for the links): put right in place, in
 * the secretary's and every workspace's .gitignore. Matched by its start, since the line had more than one wording (the
 * workspaces of this PC carry a shorter one, from before the Antigravity list was added).
 */
const OLD_GITIGNORE_HEADER = '# 스킬 연결('; // legacy-name: skill-gitignore-header
const isOldHeader = (line: string) => line.trim().startsWith(OLD_GITIGNORE_HEADER);
/** Lines of the old layout's .gitignore block, taken out when the new lines go in. */
const OLD_GITIGNORE_LINES = [ // legacy-name: old-skills-layout
  '# 공통 스킬(workspaces/_skills)로 가는 연결(비서가 common-skills.json대로 만든다, PC마다 다르다)',
  '.claude/skills/common-*',
  '.agents/skills/common-*',
];
/** The README a workspace's old skills/ folder was made with (workspace/rules-text.ts before this layout): removed with the folder. */
const OLD_WORKSPACE_README = '업무 종류별 스킬을 `<이름>/SKILL.md`로 둔다. 목록과 쓰는 법은 AGENTS.md "스킬과 기억".\n';

const abs = (root: string, rel: string) => path.join(root, ...rel.split('/'));
/** Windows paths compare without case; readlink may give a \\?\ prefix. */
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
const lstat = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
/** Where a link points, absolute and normalized (also when the target is gone). */
const linkTarget = (p: string): string | null => {
  try {
    return norm(path.resolve(path.dirname(p), fs.readlinkSync(p).replace(/^\\\\\?\\/, '')));
  } catch {
    return null;
  }
};
const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const isInside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/**
 * The skills in .agents/skills: folders with a SKILL.md, sorted. A folder may be a link to a skill another program keeps
 * up to date (Ego Lite's ego-browser) or to a common skill (common-<name>).
 */
export function skillNames(root: string): string[] {
  const dir = abs(root, SKILLS_DIR);
  return entries(dir)
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** A folder holding no file at any depth (only empty folders). */
export function isEmptyTree(dir: string): boolean {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !isEmptyTree(path.join(dir, e.name))) return false;
  }
  return true;
}

export type ClaudeState =
  /** The link to .agents/skills. */
  | 'ok'
  /** Nothing there. */
  | 'missing'
  /** A link to somewhere else, or a broken one. */
  | 'wrong'
  /** A real folder (the old layout): emptied by the fix, then made the link. */
  | 'folder'
  /** A file. */
  | 'file';

export interface SkillLayout {
  claude: ClaudeState;
  /** Where a wrong .claude/skills link points. */
  claudeTarget?: string;
  /** Links of the old layout to drop: to a skill in skills/ or .agents/skills, or a twin of a link already in .agents/skills. */
  cut: string[];
  /** Skill folders and links to move into .agents/skills (forward slashes). */
  move: { from: string; to: string }[];
  /** Real folders or files that meet one of the same name there (or are no skill): left, reported. */
  kept: string[];
  /** Old leftovers to remove: the old workspace README, then skills/ itself once empty. */
  clear: string[];
  /** .gitignore lacks the link lines (or has the old ones). */
  ignore: boolean;
}

/** A .gitignore line in any of its equivalent spellings (with or without the leading or trailing slash). */
const hasLine = (lines: string[], line: string) => {
  const bare = line.replace(/^\//, '');
  return lines.some((l) => [bare, `/${bare}`, `${bare}/`, `/${bare}/`].includes(l));
};
const ignoreLines = (root: string): string[] | null => {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  } catch {
    return null;
  }
};

/** What the fix would do in root (nothing is changed). */
export function skillLayout(root: string): SkillLayout {
  const agents = abs(root, SKILLS_DIR);
  const old = abs(root, OLD_SKILLS_DIR);
  const claude = abs(root, CLAUDE_SKILLS_DIR);
  const oldN = norm(old);
  const agentsN = norm(agents);
  const r: SkillLayout = { claude: 'missing', cut: [], move: [], kept: [], clear: [], ignore: false };
  /** Names .agents/skills has once the cuts and moves are done. */
  const taken = new Map<string, string>();
  for (const e of entries(agents)) taken.set(e.name, `${SKILLS_DIR}/${e.name}`);

  // .agents/skills: a link into skills/ (the old per-skill link) goes, so the folder it pointed at can move in.
  for (const e of entries(agents)) {
    if (!e.isSymbolicLink()) continue;
    const t = linkTarget(path.join(agents, e.name));
    if (t && isInside(t, oldN)) {
      r.cut.push(`${SKILLS_DIR}/${e.name}`);
      taken.delete(e.name);
    }
  }
  // An empty folder in .agents/skills (what a moved-out skill leaves) is taken over by a move.
  const emptyAt = (name: string) => {
    const p = path.join(agents, name);
    const st = lstat(p);
    return !!st && st.isDirectory() && !st.isSymbolicLink() && isEmptyTree(p);
  };
  const moveIn = (fromRel: string, name: string, isLink: boolean): boolean => {
    const at = taken.get(name);
    if (at && !emptyAt(name)) {
      // A link that has the same target as the one already in .agents/skills is only a twin.
      const mine = isLink ? real(abs(root, fromRel)) : null;
      if (mine && mine === real(abs(root, at))) {
        r.cut.push(fromRel);
        return true;
      }
      r.kept.push(fromRel);
      return false;
    }
    r.move.push({ from: fromRel, to: `${SKILLS_DIR}/${name}` });
    taken.set(name, `${SKILLS_DIR}/${name}`);
    return true;
  };

  // skills/ (old layout): folders and links move in; the old workspace README and then the empty folder go.
  const oldSt = lstat(old);
  if (oldSt?.isDirectory() && !oldSt.isSymbolicLink()) {
    let left = false;
    for (const e of entries(old)) {
      const rel = `${OLD_SKILLS_DIR}/${e.name}`;
      if (e.isFile() && e.name === 'README.md' && fs.readFileSync(path.join(old, e.name), 'utf8').replace(/\r\n/g, '\n') === OLD_WORKSPACE_README) r.clear.push(rel);
      else if (e.isDirectory() || e.isSymbolicLink()) left = !moveIn(rel, e.name, e.isSymbolicLink()) || left;
      else {
        r.kept.push(rel);
        left = true;
      }
    }
    if (!left) r.clear.push(OLD_SKILLS_DIR);
  }

  // .claude/skills: the one link to .agents/skills, or a real folder of the old layout to empty.
  const st = lstat(claude);
  if (!st) r.claude = 'missing';
  else if (st.isSymbolicLink()) {
    const got = real(claude);
    if (got && got === (real(agents) ?? agentsN)) r.claude = 'ok';
    else {
      r.claude = 'wrong';
      const t = linkTarget(claude);
      if (t) r.claudeTarget = t;
    }
  } else if (st.isDirectory()) {
    r.claude = 'folder';
    for (const e of entries(claude)) {
      const rel = `${CLAUDE_SKILLS_DIR}/${e.name}`;
      if (e.isSymbolicLink()) {
        const t = linkTarget(path.join(claude, e.name));
        // A link to a skill in skills/ or .agents/skills (the old per-skill link): the skill itself is moved or there.
        if (t && (isInside(t, oldN) || isInside(t, agentsN))) r.cut.push(rel);
        else moveIn(rel, e.name, true);
      } else if (e.isDirectory() && isEmptyTree(path.join(claude, e.name))) r.cut.push(rel);
      else moveIn(rel, e.name, false);
    }
  } else r.claude = 'file';

  const lines = ignoreLines(root);
  r.ignore =
    !lines ||
    !SKILL_GITIGNORE_LINES.slice(1).every((l) => hasLine(lines, l)) ||
    OLD_GITIGNORE_LINES.slice(1).some((l) => lines.includes(l)) ||
    lines.some(isOldHeader);
  return r;
}

/** The layout as short Korean phrases for the install check; [] when it is right. */
export function skillLinkProblems(r: SkillLayout): string[] {
  const out: string[] = [];
  const add = (label: string, xs: string[]) => {
    if (xs.length) out.push(`${label} ${xs.join(', ')}`);
  };
  if (r.claude === 'missing') out.push(`링크 없음: ${CLAUDE_SKILLS_DIR}`);
  if (r.claude === 'wrong') out.push(`다른 곳을 가리킴: ${CLAUDE_SKILLS_DIR}${r.claudeTarget ? `(→ ${r.claudeTarget})` : '(끊김)'}`);
  if (r.claude === 'folder') out.push(`링크 대신 실제 폴더(옛 구조): ${CLAUDE_SKILLS_DIR}`);
  if (r.claude === 'file') out.push(`링크 대신 파일: ${CLAUDE_SKILLS_DIR}`);
  add('옛 위치에서 옮길 것:', r.move.map((m) => m.from));
  // An old skills/ left with nothing to move (only the old README, or empty): its clearing is the whole fix.
  if (!r.move.length) add('옛 위치에서 지울 것:', r.clear);
  add('옛 구조의 링크:', r.cut);
  add('같은 이름이 이미 있어 옮기지 않음(지우지 않음):', r.kept);
  if (r.ignore) out.push('.gitignore에 스킬 링크 줄 없음(또는 옛 줄)');
  return out;
}

export interface SkillLinkFix {
  /** Made where there was nothing or an emptied folder (.claude/skills), and .gitignore lines added. */
  made: string[];
  /** Wrong links made again. */
  remade: string[];
  /** Old links removed and old leftovers cleared. */
  removed: string[];
  /** Moved into .agents/skills ("from → to"). */
  moved: string[];
  /** Left as they are: a name already taken, a real .claude/skills that is not empty, a file in the way. */
  kept: string[];
  failed: { rel: string; error: string }[];
}

/** A directory link: a junction on Windows (absolute target, no administrator), a relative symbolic link elsewhere. */
export function makeDirLink(at: string, target: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  if (process.platform === 'win32') fs.symlinkSync(path.resolve(target), at, 'junction');
  else fs.symlinkSync(path.relative(path.dirname(at), target), at, 'dir');
}

/** Removes a link only (never what it points at): unlink, or rmdir for a junction unlink refuses. */
export function cutLink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

/** Moves a folder or file; a link is made again at the new place with the same target, then cut. */
function moveEntry(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const dst = lstat(to);
  if (dst?.isDirectory() && !dst.isSymbolicLink() && isEmptyTree(to)) fs.rmSync(to, { recursive: true });
  if (fs.lstatSync(from).isSymbolicLink()) {
    // As written in the link (not linkTarget's lower case, which is only for comparing).
    const target = path.resolve(path.dirname(from), fs.readlinkSync(from).replace(/^\\\\\?\\/, ''));
    makeDirLink(to, target);
    cutLink(from);
    return;
  }
  fs.renameSync(from, to);
}

/** Adds the link lines to .gitignore (taking out the old block's, and putting an old header right in place), keeping the rest. Returns whether it changed. */
export function fixSkillIgnore(root: string): boolean {
  const file = path.join(root, '.gitignore');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const kept = old
    .split(/\r?\n/)
    .filter((l) => !OLD_GITIGNORE_LINES.includes(l.trim()))
    .map((l) => (isOldHeader(l) ? SKILL_GITIGNORE_LINES[0] : l));
  while (kept.length && kept.at(-1)!.trim() === '') kept.pop();
  const trimmed = kept.map((k) => k.trim());
  const missing = SKILL_GITIGNORE_LINES.slice(1).filter((l) => !hasLine(trimmed, l));
  // Some lines already there (a line added later): the missing ones go right after them, without a second header.
  const last = Math.max(...SKILL_GITIGNORE_LINES.slice(1).map((l) => trimmed.findLastIndex((k) => hasLine([k], l))));
  const lines = !missing.length
    ? kept
    : last >= 0
      ? [...kept.slice(0, last + 1), ...missing, ...kept.slice(last + 1)]
      : [...kept, ...(kept.length ? [''] : []), SKILL_GITIGNORE_LINES[0], ...missing];
  const text = `${lines.join('\n')}\n`;
  if (text === old) return false;
  fs.writeFileSync(file, text);
  return true;
}

/** Puts the layout right (dryRun: only says what it would do). Real folders and files that meet another are left and listed. */
export function fixSkillLinks(root: string, { dryRun = false } = {}): SkillLinkFix {
  const r = skillLayout(root);
  const fix: SkillLinkFix = { made: [], remade: [], removed: [], moved: [], kept: [...r.kept], failed: [] };
  const attempt = (rel: string, list: string[], act: () => void) => {
    try {
      if (!dryRun) act();
      list.push(rel);
    } catch (err) {
      fix.failed.push({ rel, error: (err as Error).message });
    }
  };
  if (r.ignore) attempt('.gitignore', fix.made, () => fixSkillIgnore(root));
  for (const rel of r.cut) attempt(rel, fix.removed, () => (lstat(abs(root, rel))?.isSymbolicLink() ? cutLink(abs(root, rel)) : fs.rmSync(abs(root, rel), { recursive: true })));
  for (const m of r.move) attempt(`${m.from} → ${m.to}`, fix.moved, () => moveEntry(abs(root, m.from), abs(root, m.to)));
  for (const rel of r.clear) {
    const p = abs(root, rel);
    // skills/ itself only once everything in it went (a failed move leaves it).
    if (rel === OLD_SKILLS_DIR) {
      if (!fix.failed.length) attempt(rel, fix.removed, () => {
        if (!isEmptyTree(p)) throw new Error('폴더가 비지 않음');
        fs.rmSync(p, { recursive: true });
      });
    } else attempt(rel, fix.removed, () => fs.rmSync(p));
  }
  const agents = abs(root, SKILLS_DIR);
  const claude = abs(root, CLAUDE_SKILLS_DIR);
  const link = () => {
    fs.mkdirSync(agents, { recursive: true });
    makeDirLink(claude, agents);
  };
  if (r.claude === 'missing') attempt(CLAUDE_SKILLS_DIR, fix.made, link);
  else if (r.claude === 'wrong')
    attempt(CLAUDE_SKILLS_DIR, fix.remade, () => {
      cutLink(claude);
      link();
    });
  else if (r.claude === 'folder') {
    // Emptied by the cuts and moves above, unless something was left there.
    if (r.kept.some((k) => k.startsWith(`${CLAUDE_SKILLS_DIR}/`))) fix.kept.push(CLAUDE_SKILLS_DIR);
    else
      attempt(CLAUDE_SKILLS_DIR, fix.made, () => {
        if (!isEmptyTree(claude)) throw new Error('폴더가 비지 않음');
        fs.rmSync(claude, { recursive: true });
        link();
      });
  } else if (r.claude === 'file') fix.kept.push(CLAUDE_SKILLS_DIR);
  return fix;
}

/** The fix as lines for the command line (`node src/cli.ts skill-links`). */
export function formatSkillLinkFix(fix: SkillLinkFix, dryRun: boolean, label = '스킬 링크'): string[] {
  const verb = (done: string, plan: string) => (dryRun ? plan : done);
  const lines = [
    ...fix.moved.map((m) => `${verb('옮김', '옮길 것')}: ${m}`),
    ...fix.removed.map((r) => `${verb('지움', '지울 것')}(옛 구조의 링크·빈 폴더): ${r}`),
    ...fix.made.map((r) => (r === '.gitignore' ? `${verb('고침', '고칠 것')}: .gitignore(스킬 링크 줄)` : `${verb('만듦', '만들 것')}: ${r} → ${SKILLS_DIR}`)),
    ...fix.remade.map((r) => `${verb('다시 만듦', '다시 만들 것')}(다른 곳을 가리켰음): ${r} → ${SKILLS_DIR}`),
    ...fix.kept.map((r) => `그대로 둠(같은 이름이 이미 있거나 실제 폴더·파일이라 지우지 않는다): ${r}`),
    ...fix.failed.map((f) => `실패: ${f.rel} (${f.error})`),
  ];
  const n = fix.made.length + fix.remade.length + fix.removed.length + fix.moved.length;
  lines.push(
    n || fix.kept.length || fix.failed.length
      ? `${label} ${verb('고친 것', '고칠 것')} ${n}개${fix.kept.length ? `, 그대로 둔 것 ${fix.kept.length}개` : ''}${fix.failed.length ? `, 실패 ${fix.failed.length}개` : ''}`
      : `${label}: 모두 맞음`,
  );
  return lines;
}
