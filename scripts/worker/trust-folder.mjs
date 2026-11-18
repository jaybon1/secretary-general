// 공간 폴더를 Claude Code 설정(.claude.json)에 '신뢰함'으로 적는다. start-worker.ps1이 업무 세션을 띄우기 전에 부른다.
// 지금 버전의 백그라운드 세션(claude --bg)은 상위 폴더 신뢰를 이어받지 않아, 공간 폴더마다 승인 창을 눌러야 했다.
// 상위 폴더 중 하나가 이미 신뢰돼 있을 때만 적는다. 설정 폴더: CLAUDE_CONFIG_DIR, 없으면 홈.
// 이 파일은 돌고 있는 Claude Code(비서 자신 포함)도 수시로 고쳐 쓴다. 그래서 통째로 읽었다가 덮어쓰지 않고, 같은 폴더의 임시 파일에
// 쓴 뒤 그사이 원본이 바뀌지 않았을 때만 이름 바꾸기 한 번으로 갈아 끼운다. 바뀌었으면 새로 읽은 내용에 이 폴더 항목만 다시 얹는다.
// 끝내 못 바꾸면 적지 않고 알린다(남이 쓴 내용을 지우는 것보다 승인 창이 한 번 뜨는 편이 낫다).
//
// 예: node scripts/worker/trust-folder.mjs <공간 폴더>
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const key = (p) => resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Marks `folder` trusted in the config text when a trusted folder above it is already there.
 * Returns { text, line } to write, or { line } alone when there is nothing to write.
 */
export function trustedText(raw, folder) {
  const config = JSON.parse(raw);
  const projects = (config.projects ??= {});
  const entry = Object.entries(projects).find(([k]) => same(k, folder));
  if (entry?.[1]?.hasTrustDialogAccepted) return { line: '' };
  const parent = Object.entries(projects).find(([k, v]) => v?.hasTrustDialogAccepted && folder.toLowerCase().startsWith(k.toLowerCase() + '/'));
  if (!parent) return { line: `신뢰: 신뢰된 상위 폴더가 없어 적지 않았어요 (${folder})` };
  if (entry) entry[1].hasTrustDialogAccepted = true;
  else projects[folder] = { allowedTools: [], hasTrustDialogAccepted: true };
  return { text: JSON.stringify(config, null, 2), line: `신뢰: ${folder} (상위 ${parent[0]} 기준)` };
}

/**
 * Writes the trust into `file` without losing what another process wrote meanwhile: the new text goes to a temp file beside
 * it and replaces the original (one rename) only if the original still reads as it did when the text was made; otherwise
 * it starts again from the fresh content. `beforeSwap` is for tests (another writer between the read and the swap).
 * Returns the line to print ('' when the folder was already trusted).
 */
export function trustFolder(file, folderArg, { tries = 5, beforeSwap } = {}) {
  const folder = key(folderArg);
  if (!existsSync(file)) return `신뢰: 설정 파일이 없어요 (${file})`;
  const temp = join(dirname(resolve(file)), `.${basename(file)}.trust-${process.pid}.tmp`);
  try {
    for (let i = 0; i < tries; i++) {
      const raw = readFileSync(file, 'utf8');
      let r;
      try {
        r = trustedText(raw, folder);
      } catch {
        pause(100); // caught halfway through someone's write: read again
        continue;
      }
      if (r.text === undefined) return r.line;
      writeFileSync(temp, r.text);
      beforeSwap?.(i);
      if (readFileSync(file, 'utf8') !== raw) continue; // someone wrote meanwhile: make the text again from theirs
      try {
        renameSync(temp, file);
        return r.line;
      } catch {
        pause(100); // held open for a moment (Windows): try again
      }
    }
    return `신뢰: 설정 파일이 계속 바뀌거나 잠겨 있어 적지 않았어요 (${file}). 업무 세션에 폴더 신뢰 승인 창이 뜰 수 있어요.`;
  } finally {
    rmSync(temp, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = trustFolder(join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'), process.argv[2]);
  if (line) console.log(line);
}
