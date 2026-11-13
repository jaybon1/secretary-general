/**
 * How a workspace's tools find the secretary's scripts: a small `secretary-link.local.json` at the top of each workspace
 * folder (until 2026-11-10 `secretary.json`: OLD_LINK_FILE below),
 * written by the secretary ({ bin: the secretary's entrance folder bin/, id: its secretary id }). Only the entrance
 * folder is named, not the secretary folder itself: tools call the fixed names in bin/ (core/paths.ts ENTRY_POINTS)
 * and nothing else of the secretary (a worker's shell commands that touch the secretary folder otherwise are blocked,
 * scripts/worker/worker-folder-guard.mjs). A tool reads the file (searching upward from its own folder; the code is in the
 * workspace charter, workspace/rules-text.ts findSecretaryCode) instead of an environment variable, so it needs no
 * variable name and a workspace moved to another secretary changes one file. Paths differ per PC, so the file stays
 * out of the workspace's git (.gitignore).
 *
 * Written when a workspace is made (workspace/workspace-create.ts) and put right whenever a task is handed to it
 * (create_task); the install check (setup/check-items.ts 'workspace-links') lists workspaces whose file is missing or
 * points elsewhere, and `node src/cli.ts workspace-links` fixes them all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY_DIR } from '../core/paths.ts';
import { readSecretaryId } from '../core/secretary-id.ts';
import { fixSkillLinks, skillLayout, skillLinkProblems } from '../setup/skill-links.ts';
import { fixCharter } from './charter-blocks.ts';
import { commonSkillProblem, commonSkillsDirOf, fixCommonSkills } from './common-skills.ts';
import { blockBegin, renderMemory } from './rules-text.ts';
import { LINK_FILE, MEMORY_FILE, PENDING_DIR, RUN_JOB_HOME, workspaceRootOf } from './workspace-paths.ts';

export { commonSkillsDirOf, LINK_FILE, RUN_JOB_HOME, workspaceRootOf };
/**
 * The file's name until 2026-11-10. Workspace tools that copied the old finding code read it, so while one is there the
 * secretary keeps it the same as the new one (writeLink; never makes a new one). Goes once 0.10.0 is out and the
 * workspaces' tools read the new name.
 */
export const OLD_LINK_FILE = 'secretary.json'; // legacy-name: secretary-link-file

export interface SecretaryLink {
  about?: string;
  /** The secretary's entrance folder (<secretary folder>/bin). */
  bin: string;
  /** Its secretary id (core/secretary-id.ts); absent while it has none. */
  id?: string;
}

const ABOUT = '비서가 써 두는 파일: 이 공간을 맡은 비서의 진입점 폴더(bin)와 비서 고유 번호(id). 공간 도구는 이 bin 안의 이름으로만 비서 스크립트를 부른다. PC마다 달라 커밋하지 않는다(.gitignore).';

/** The file's text for the secretary at root. */
const linkText = (root: string) => `${JSON.stringify(linkFor(root), null, 2)}\n`;

/** What the file should hold for the secretary at root. */
export function linkFor(root: string): SecretaryLink {
  const id = readSecretaryId(root);
  return { about: ABOUT, bin: path.join(path.resolve(root), ENTRY_DIR), ...(id ? { id } : {}) };
}

export function readLink(folder: string): SecretaryLink | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(folder, LINK_FILE), 'utf8').replace(/^﻿/, ''));
    return v && typeof v.bin === 'string' ? v : null;
  } catch {
    return null;
  }
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

const ignores = (folder: string) => {
  try {
    return fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').split(/\r?\n/).some((l) => [LINK_FILE, `/${LINK_FILE}`, '*.local.json'].includes(l.trim()));
  } catch {
    return false;
  }
};

/** The old-name file's text when it is there and not the same as the new one (it is kept the same while there). */
function staleOldLink(folder: string, text: string): boolean { // legacy-name: secretary-link-file
  const old = path.join(folder, OLD_LINK_FILE);
  try {
    return fs.readFileSync(old, 'utf8') !== text;
  } catch {
    return false;
  }
}

/**
 * Why folder's link is not right for the secretary at root, every problem joined with "; "; null when it is. All of them, not
 * the first: a link pointing elsewhere hid an old charter sentence behind it (2026-11-10).
 */
export function linkProblem(folder: string, root: string): string | null {
  const file = path.join(folder, LINK_FILE);
  const link = readLink(folder);
  const want = linkFor(root);
  const out: string[] = [];
  if (!link) out.push(fs.existsSync(file) ? `${LINK_FILE}을 못 읽음` : `${LINK_FILE} 없음`);
  else {
    if (norm(link.bin) !== norm(want.bin)) out.push(`다른 폴더를 가리킴: ${link.bin}`);
    if ((link.id ?? null) !== (want.id ?? null)) out.push(`번호가 다름: ${link.id ?? '(없음)'}`);
    if (Object.keys(link).some((k) => !['about', 'bin', 'id'].includes(k))) out.push('다른 키가 있음');
  }
  if (!ignores(folder)) out.push(`.gitignore에 ${LINK_FILE} 없음`);
  if (oldIgnoreComment(folder)) out.push('.gitignore 주석에 2026-11-11에 쉬운 말로 바꾼 옛 말이 남음');
  if (staleOldLink(folder, linkText(root))) out.push(`옛 이름 ${OLD_LINK_FILE}이 새 파일과 다름`);
  const skills = skillProblem(folder, root);
  if (skills) out.push(skills);
  return out.length ? out.join('; ') : null;
}

/** The skill layout (setup/skill-links.ts), the charter's secretary blocks and the common skills of a workspace; null when right. */
export function skillProblem(folder: string, root: string): string | null {
  const out = skillLinkProblems(skillLayout(folder));
  const charter = charterProblem(folder, root);
  if (charter) out.push(charter);
  const common = commonSkillProblem(folder, commonSkillsDirOf(root));
  if (common) out.push(common);
  return out.length ? out.join('; ') : null;
}

/** The lines .gitignore gets: the reason, then the file. */
export const GITIGNORE_LINES = ['# 이 공간을 맡은 비서의 진입점 폴더(비서가 써 둔다, PC마다 다르다)', LINK_FILE];
/** The comment line GITIGNORE_LINES[0] was until 2026-11-11 → what it is now: put right in place in a workspace's .gitignore. */
const GITIGNORE_COMMENT_FIX: [string, string] = // legacy-name: link-gitignore-comment
  ['# 이 공간을 맡은 비서의 입구 폴더(비서가 써 둔다, PC마다 다르다)', GITIGNORE_LINES[0]];

const ignoreText = (folder: string) => {
  try {
    return fs.readFileSync(path.join(folder, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
};
const oldIgnoreComment = (folder: string) => ignoreText(folder).includes(GITIGNORE_COMMENT_FIX[0]);

/**
 * Writes folder's link for the secretary at root, and its .gitignore line first (so a worker's `git add -A` never
 * takes it), and puts its skill links, common skills and charter blocks right. addMissing: a charter without marks that
 * lacks a section the template has gets it (workspace-links --add-missing, after the user said yes). Returns whether
 * anything changed (or was tried: a charter left with a problem stays as it was).
 */
export function writeLink(folder: string, root: string, addMissing = false): boolean {
  if (!linkProblem(folder, root) && !(addMissing && charterFix(folder, root, true))) return false;
  if (!ignores(folder)) {
    const file = path.join(folder, '.gitignore');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = old && !old.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, `${old}${sep}${GITIGNORE_LINES.join('\n')}\n`);
  }
  if (oldIgnoreComment(folder)) fs.writeFileSync(path.join(folder, '.gitignore'), ignoreText(folder).replaceAll(...GITIGNORE_COMMENT_FIX));
  const file = path.join(folder, LINK_FILE);
  const text = linkText(root);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  // The old-name file, where it is, is kept the same for tools that still read it (never made new).
  if (staleOldLink(folder, text)) fs.writeFileSync(path.join(folder, OLD_LINK_FILE), text); // legacy-name: secretary-link-file
  fixSkillLinks(folder);
  fixCommonSkills(folder, commonSkillsDirOf(root));
  const charter = charterFix(folder, root, addMissing);
  if (charter && 'text' in charter) {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), charter.text);
    // A charter that got the "스킬과 기억" block (addMissing) also gets the files it names, as a new workspace has them.
    if (charter.text.includes(blockBegin('learning')) && !fs.existsSync(path.join(folder, MEMORY_FILE))) {
      const title = charter.text.match(/^# (.+)$/m)?.[1] ?? path.basename(folder);
      fs.writeFileSync(path.join(folder, MEMORY_FILE), renderMemory({ kind: 'solo', name: '', title, purpose: '' }));
      fs.mkdirSync(path.join(folder, PENDING_DIR), { recursive: true });
      if (!fs.readdirSync(path.join(folder, PENDING_DIR)).length) fs.writeFileSync(path.join(folder, PENDING_DIR, '.gitkeep'), '');
    }
  }
  return true;
}

/**
 * The charter (AGENTS.md) as the template wants it (workspace/charter-blocks.ts), only when that differs from the file, or why it
 * is left; null when it is right or there is none. A charter goes out with LF line endings: git checks it out as CRLF
 * (core.autocrlf) while the secretary writes LF, and stores LF either way.
 */
function charterFix(folder: string, root: string, addMissing = false): { text: string; moved: boolean } | { problem: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
  } catch {
    return null;
  }
  const fix = fixCharter(text, folder, root, addMissing);
  return 'text' in fix && fix.text === text ? null : fix;
}

function charterProblem(folder: string, root: string): string | null {
  const fix = charterFix(folder, root);
  if (!fix) return null;
  if ('problem' in fix) return fix.problem;
  return fix.moved ? 'AGENTS.md에 비서 표시가 없음(비서 관리 부분을 표시로 감싸 지금 틀로 옮길 수 있음)' : 'AGENTS.md의 비서 표시 안이 지금 틀과 다름';
}

/**
 * The folders that should carry a link: every workspace in the database that takes work and is on this PC, and
 * run-job's home folder. A workspace recorded at a path that is gone is left to create_task (it finds moved ones).
 */
export function linkedFolders(dbPath: string, root: string): string[] {
  const folders: string[] = [];
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get();
      if (has) for (const r of db.prepare('SELECT folder FROM workspaces WHERE archived_at IS NULL ORDER BY id').all() as { folder: string }[]) folders.push(r.folder);
    } finally {
      db.close();
    }
  }
  folders.push(path.join(workspaceRootOf(root), RUN_JOB_HOME));
  const seen = new Set<string>();
  return folders.filter((f) => fs.existsSync(f) && fs.statSync(f).isDirectory() && !seen.has(norm(f)) && !!seen.add(norm(f)));
}

/** Each linked folder whose link is not right, with why. */
export function linkProblems(dbPath: string, root: string): { folder: string; problem: string }[] {
  return linkedFolders(dbPath, root).flatMap((folder) => {
    const problem = linkProblem(folder, root);
    return problem ? [{ folder, problem }] : [];
  });
}
