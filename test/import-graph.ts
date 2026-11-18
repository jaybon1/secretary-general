/**
 * The repository's import graph (feature 'setup-check'), read from the source text without a parser: each .ts/.mjs/.js
 * file's relative `import … from '…'`, `export … from '…'`, `import '…'` and `import('…')` paths, resolved to files that
 * exist. Used three ways:
 *
 *   - test:changed (test/run-changed.ts) picks every test that reaches a changed file, directly or through other files.
 *   - test/import-graph.test.ts fails on an import cycle between files and on an import against the folder direction (LAYERS).
 *   - `npm run graph` writes the folder graph as Mermaid (docs/… is not made: it prints, or writes to --out).
 *
 * Why not a graph package (dependency-cruiser): it reads TypeScript through the `typescript` package's compiler API, which
 * TypeScript 7.0 (this repository's compiler) does not have, and its other TypeScript parser (swc) is deprecated.
 *
 * What the text reading misses, on purpose: imports built from variables, `require(…)`, and a .ps1 that starts a node file
 * (test:changed still picks those by feature). A path inside a string or comment that looks like an import counts only if
 * the line starts with `import`/`export` or it is an `import('…')` call, and only if the file is there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where code lives; node_modules and release builds are not walked. */
const SCAN_DIRS = ['src', 'scripts', 'bin', 'test'];
const CODE = /\.(ts|mts|mjs|js|cjs)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'fixtures']);

export interface Edge {
  to: string;
  /** `import type …` / `export type … from`: gone after type stripping, so it cannot make a load-order cycle. */
  typeOnly: boolean;
}

/** file (posix path from the root) → what it imports. */
export type Graph = Record<string, Edge[]>;

function walk(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(root, rel, out);
    } else if (CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
  }
}

/** The relative import paths in a file's text, with whether each is type-only. */
export function importsIn(text: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  // Static: a statement starting a line, up to its `from '…'` (may span lines), or a bare `import '…'`.
  for (const m of text.matchAll(/^[ \t]*(import|export)\s+(type\s+)?(?:[^;'"`]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    out.push({ spec: m[3], typeOnly: !!m[2] });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** The file a relative import names, as a root-relative posix path, or null if nothing is there. */
export function resolveImport(root: string, from: string, spec: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base.startsWith('..')) return null;
  for (const cand of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]) {
    try {
      if (fs.statSync(path.join(root, cand)).isFile()) return cand;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** Every code file under SCAN_DIRS and what it imports inside the repository. */
export function buildGraph(root = ROOT): Graph {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(root, d, files);
  const g: Graph = {};
  for (const f of files.sort()) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const edges = new Map<string, Edge>();
    for (const { spec, typeOnly } of importsIn(text)) {
      const to = resolveImport(root, f, spec);
      if (!to || to === f) continue;
      const had = edges.get(to);
      edges.set(to, { to, typeOnly: had ? had.typeOnly && typeOnly : typeOnly });
    }
    g[f] = [...edges.values()];
  }
  return g;
}

/** Every file that reaches one of `targets` through imports (type-only included: a changed type can break its users). */
export function dependentsOf(g: Graph, targets: string[]): Set<string> {
  const back = new Map<string, string[]>();
  for (const [from, edges] of Object.entries(g)) for (const e of edges) back.set(e.to, [...(back.get(e.to) ?? []), from]);
  const seen = new Set<string>();
  const todo = [...targets];
  while (todo.length) {
    const t = todo.pop()!;
    for (const from of back.get(t) ?? []) if (!seen.has(from)) {
      seen.add(from);
      todo.push(from);
    }
  }
  return seen;
}

/**
 * What each test file reaches through runtime imports, directly or through other files (type-only imports are left out:
 * they are gone when the test runs), as root paths without the test folder's own files. test:changed picks a test when it
 * reaches a changed file.
 */
export function testReach(g: Graph = buildGraph()): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of Object.keys(g).filter((f) => /^test\/(release-build\/)?[^/]+\.test\.ts$/.test(f))) {
    const seen = new Set<string>();
    const todo = [t];
    while (todo.length) {
      for (const e of g[todo.pop()!] ?? []) if (!e.typeOnly && !seen.has(e.to)) {
        seen.add(e.to);
        todo.push(e.to);
      }
    }
    out[t] = [...seen].filter((f) => !f.startsWith('test/')).sort();
  }
  return out;
}

/** Strongly connected groups of more than one node (Tarjan), each sorted, over `edges(node)`. */
export function cycles<N extends string>(nodes: N[], edges: (n: N) => N[]): N[][] {
  let index = 0;
  const idx = new Map<N, number>();
  const low = new Map<N, number>();
  const onStack = new Set<N>();
  const stack: N[] = [];
  const out: N[][] = [];
  const visit = (v: N): void => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const group: N[] = [];
      let w: N;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}

/** File-level import cycles over runtime imports (type-only edges cannot change load order, so they are left out). */
export const fileCycles = (g: Graph): string[][] => cycles(Object.keys(g), (f) => (g[f] ?? []).filter((e) => !e.typeOnly).map((e) => e.to).filter((t) => t in g));

/** The folder a file counts under: src/<dir>, scripts/<dir>, or the top folder (src/cli.ts → 'src/cli.ts' itself). */
export function folderOf(file: string): string {
  const parts = file.split('/');
  if ((parts[0] === 'src' || parts[0] === 'scripts') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'src') return file;
  return parts[0];
}

/** Folder → folder edges with how many file imports make each (all imports, type-only too). */
export function folderEdges(g: Graph): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [from, edges] of Object.entries(g)) {
    const a = folderOf(from);
    for (const e of edges) {
      const b = folderOf(e.to);
      if (a === b) continue;
      const m = out.get(a) ?? new Map<string, number>();
      m.set(b, (m.get(b) ?? 0) + 1);
      out.set(a, m);
    }
  }
  return out;
}

/**
 * The folder direction: a folder may import its own layer's folders and lower layers, never a higher one, and the folder
 * graph has no cycle (folderCycles), so two folders on one layer cannot lean on each other both ways. Layer 0 is the base
 * every feature leans on; the top src layer holds the entries (hooks, MCP tools, idle jobs, cli) that tie features
 * together. scripts/, bin/ and test/ sit above everything. A folder not listed fails the test, so a new folder gets a
 * place on purpose.
 */
export const LAYERS: Array<{ layer: number; folders: string[]; what: string }> = [
  { layer: 0, folders: ['src/core'], what: '바탕(경로·이름·설정·대화 기록 읽기·시간)' },
  { layer: 1, folders: ['src/store'], what: 'DB(표·옮기기·검색 색인 글, 기능마다 DB에 두는 값)' },
  {
    layer: 2,
    folders: ['src/phone-push', 'src/semantic-search', 'src/usage', 'src/mistake-guards', 'src/workspace'],
    what: '혼자 서는 기능(폰 알림, 의미 검색, 사용량, 답 검사, 업무 공간)',
  },
  { layer: 3, folders: ['src/staff', 'src/log', 'src/memory'], what: '정리 담당 띄우기, 대화 기록, 기억' },
  { layer: 4, folders: ['src/session-continuity', 'src/todo-summary'], what: '이어 가기(상황판·넘기기), 할 일 요약' },
  { layer: 5, folders: ['src/setup', 'src/dashboard'], what: '여러 기능을 모아 보는 것(설치 점검, 대시보드)' },
  { layer: 6, folders: ['src/hooks', 'src/mcp', 'src/idle', 'src/cli.ts'], what: '입구(훅, MCP 도구, 쉬는 시간 작업, cli)' },
  { layer: 7, folders: ['scripts', 'bin', 'test'], what: '스크립트·bin·시험(무엇이든 부를 수 있음)' },
];
const TOP_LAYER = Math.max(...LAYERS.map((l) => l.layer));

export function layerOf(folder: string): number | undefined {
  const top = folder.split('/')[0];
  for (const l of LAYERS) if (l.folders.includes(folder) || l.folders.includes(top)) return l.layer;
  return undefined;
}

/** Cycles between src folders (scripts, bin and test may lean on each other: they are not layered among themselves). */
export function folderCycles(g: Graph): string[][] {
  const fe = folderEdges(g);
  const src = [...new Set(Object.keys(g).map(folderOf))].filter((f) => f.startsWith('src/'));
  return cycles(src, (f) => [...(fe.get(f)?.keys() ?? [])].filter((t) => t.startsWith('src/')));
}

/** Imports kept against the folder direction on purpose, each with why. */
export const DIRECTION_ALLOWED: string[] = [
];

/**
 * Imports that break the folder direction, as `from → to` lines. `allowed` lists file pairs kept on purpose
 * ("from -> to"), each with its reason where it is defined.
 */
export function directionBreaks(g: Graph, allowed: string[] = []): string[] {
  const out: string[] = [];
  for (const [from, edges] of Object.entries(g)) {
    const a = folderOf(from);
    const la = layerOf(a);
    for (const e of edges) {
      const b = folderOf(e.to);
      if (a === b) continue;
      const lb = layerOf(b);
      const line = `${from} -> ${e.to}`;
      if (la === undefined) out.push(`${line} (${a}: LAYERS에 없는 폴더)`);
      else if (lb === undefined) out.push(`${line} (${b}: LAYERS에 없는 폴더)`);
      else if (lb > la && !allowed.includes(line)) out.push(`${line} (층 ${la} → ${lb})`);
    }
  }
  return [...new Set(out)].sort();
}

/** The folder graph as a Mermaid flowchart, folders grouped by layer, edges labelled with their file-import counts. */
export function mermaid(g: Graph): string {
  const fe = folderEdges(g);
  const folders = new Set<string>(Object.keys(g).map(folderOf));
  const id = (f: string) => f.replace(/[^A-Za-z0-9]/g, '_');
  const lines = ['flowchart TB'];
  for (const l of LAYERS) {
    const mine = [...folders].filter((f) => layerOf(f) === l.layer).sort();
    if (!mine.length) continue;
    lines.push(`  subgraph L${l.layer}["층 ${l.layer}: ${l.what}"]`);
    for (const f of mine) lines.push(`    ${id(f)}["${f}"]`);
    lines.push('  end');
  }
  const loose = [...folders].filter((f) => layerOf(f) === undefined).sort();
  for (const f of loose) lines.push(`  ${id(f)}["${f} (층 없음)"]`);
  for (const [a, m] of [...fe.entries()].sort()) {
    // Scripts, bin and tests reach nearly everything; drawing their edges hides the src structure.
    if (layerOf(a) === TOP_LAYER) continue;
    for (const [b, n] of [...m.entries()].sort()) lines.push(`  ${id(a)} -->|${n}| ${id(b)}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  const g = buildGraph();
  const i = args.indexOf('--out');
  const text = mermaid(g);
  if (i >= 0 && args[i + 1]) {
    fs.writeFileSync(path.resolve(args[i + 1]), args[i + 1].endsWith('.md') ? `\`\`\`mermaid\n${text}\`\`\`\n` : text);
    console.log(`의존 관계 그림을 썼어요: ${path.resolve(args[i + 1])}`);
  } else process.stdout.write(text);
  if (args.includes('--check')) {
    for (const c of fileCycles(g)) console.log(`파일 고리: ${c.join(' ↔ ')}`);
    for (const c of folderCycles(g)) console.log(`폴더 고리: ${c.join(' ↔ ')}`);
    for (const b of directionBreaks(g, DIRECTION_ALLOWED)) console.log(`방향: ${b}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
