/**
 * A workspace charter's (AGENTS.md) secretary blocks kept to the template (workspace/rules-text.ts): workspace-links writes
 * what is between each block's marks again and leaves the rest of the file as it is. A charter without marks is not
 * changed: the reason is reported, the secretary marks that charter itself, then workspace-links keeps it like any other.
 */
import { BLOCK_MARK, blockEnd, charterBlockLines, type CharterContext, wrapBlock } from './rules-text.ts';

export type CharterFix = { text: string } | { problem: string };

/** The charter text as the template wants it for the secretary at root, or why it is left. The text comes in with LF. */
export function fixCharter(text: string, root: string): CharterFix {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.some((l) => BLOCK_MARK.test(l))) return rewriteBlocks(lines, root);
  return { problem: 'AGENTS.md에 비서 표시가 없음(비서 관리 부분을 <!-- secretary:begin <이름> --> … <!-- secretary:end <이름> -->로 감싸면 workspace-links가 표시 안을 지금 틀로 맞춘다)' };
}

/** Every block between its marks written again; a mark without its pair or a name the template does not have is reported. */
function rewriteBlocks(lines: string[], root: string): CharterFix {
  const ids = lines.flatMap((l) => (l.match(BLOCK_MARK)?.[1] === 'begin' ? [l.match(BLOCK_MARK)![2]] : []));
  const c: CharterContext = { hasHistory: ids.includes('learning'), root };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BLOCK_MARK);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const id = m[2];
    const end = lines.indexOf(blockEnd(id), i + 1);
    const next = lines.findIndex((l, j) => j > i && BLOCK_MARK.test(l));
    if (m[1] !== 'begin' || end < 0 || next !== end) return { problem: `AGENTS.md의 비서 표시 짝이 맞지 않음(${lines[i]})` };
    const body = charterBlockLines(id, c);
    if (!body) return { problem: `AGENTS.md에 틀에 없는 비서 표시: ${id}` };
    out.push(...wrapBlock(id, body));
    i = end;
  }
  return { text: out.join('\n') };
}
