// 서브에이전트 보고 저장(기능 'delegate'). 비서 세션의 서브에이전트(Agent)가 마지막에 보낸 보고를 원문 그대로 결과 폴더의 REPORT.md로 쓴다.
//   node scripts/subagent-report/subagent-report.ts <agent id> <결과 폴더> [--name <파일 이름>] [--session <비서 세션 id>] [--config <설정 폴더>]... [--force]
// Claude Code는 서브에이전트가 REPORT.md라는 이름으로 파일을 쓰는 것을 막고 보고를 마지막 답으로만 받게 한다. 비서가 그 보고를 직접
// 옮겨 적으면 보고 길이만큼 출력이 들고 옮기다 빠지거나 섞여서, 서브에이전트 대화 기록에 남은 보고를 그대로 꺼내 쓴다.
// 대화 기록: <설정 폴더>/projects/<비서 프로젝트 폴더>/<비서 세션 uuid>/subagents/agent-<agent id>.jsonl. 설정 폴더는 지금 프로세스의
// CLAUDE_CONFIG_DIR, ~/.claude, 구독 공급자 키 파일의 설정 폴더(src/core/provider-accounts.ts accountConfigDirs), 홈의 .claude-<이름> 폴더
// (예: .claude-b)를 차례로 본다. --config를 주면 그 폴더만 본다. 비서 프로젝트 폴더를 먼저 보고, 없으면 다른 프로젝트 폴더도 본다.
// 보고: 그 기록의 마지막 SubagentHandback 도구 호출 입력의 message. 없으면(SubagentHandback이 없던 판) 마지막 답의 글을 쓰고 그렇다고 알린다.
// 같은 이름의 파일이 이미 있고 내용이 다르면 쓰지 않고 멈춘다(--force면 덮어쓴다).
// 종료 코드: 0 = 저장(또는 이미 같음), 1 = 못 씀(이미 다른 내용이 있음 등), 2 = 기록이나 보고를 못 찾음·쓰는 법 오류.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/core/config.ts';
import { accountConfigDirs } from '../../src/core/provider-accounts.ts';
import { blocks, parseLine, projectFolderName, type TranscriptRecord } from '../../src/core/transcript.ts';

const USAGE = 'usage: node scripts/subagent-report/subagent-report.ts <agent id> <결과 폴더> [--name <파일 이름>] [--session <비서 세션 id>] [--config <설정 폴더>]... [--force]';

/** 'agent-a6d8…', 'a6d8…', 'agent-a6d8….jsonl' → 'a6d8…'. */
export const normalizeAgentId = (id: string): string =>
  id
    .trim()
    .replace(/\.jsonl$/i, '')
    .replace(/^agent-/i, '');

/** Config folders to look in: the given ones, else this process's, ~/.claude, each subscription's, and ~/.claude-<name>. */
export function configDirs(given: string[], home = os.homedir()): string[] {
  if (given.length) return given;
  let extra: string[] = [];
  try {
    extra = fs
      .readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\.claude-[\w.-]+$/i.test(d.name))
      .map((d) => path.join(home, d.name));
  } catch {
    // No home listing: the known folders only.
  }
  return [...new Set([...accountConfigDirs(), ...extra])];
}

/**
 * The transcript of subagent `agentId` under the config folders: the secretary's project folder first (`projectFolder`),
 * then every other project folder; in `session`'s folder only when given. The newest when more match; null when none.
 */
export function findSubagentTranscript(dirs: string[], agentId: string, opts: { projectFolder?: string; session?: string } = {}): string | null {
  const name = `agent-${agentId}.jsonl`.toLowerCase();
  const found: { file: string; mtime: number }[] = [];
  const look = (projectDir: string): void => {
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      if (opts.session && s.name.toLowerCase() !== opts.session.toLowerCase()) continue;
      const sub = path.join(projectDir, s.name, 'subagents');
      let names: string[];
      try {
        names = fs.readdirSync(sub);
      } catch {
        continue;
      }
      for (const n of names) {
        if (n.toLowerCase() !== name) continue;
        const file = path.join(sub, n);
        try {
          found.push({ file, mtime: fs.statSync(file).mtimeMs });
        } catch {
          // Gone between the listing and the look.
        }
      }
    }
  };
  for (const dir of dirs) {
    const projects = path.join(dir, 'projects');
    if (opts.projectFolder) look(path.join(projects, opts.projectFolder));
    if (found.length) continue;
    let all: fs.Dirent[];
    try {
      all = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of all) if (p.isDirectory() && p.name !== opts.projectFolder) look(path.join(projects, p.name));
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.file ?? null;
}

export interface SubagentReport {
  text: string;
  /** handback: the SubagentHandback call's message; lastText: no handback, the last answer's text. */
  from: 'handback' | 'lastText';
}

/** The report in a subagent's transcript lines: the last SubagentHandback message, else the last answer's text; null when neither. */
export function subagentReport(lines: string[]): SubagentReport | null {
  const records = lines.map((l) => parseLine(l.trim())).filter((o): o is TranscriptRecord => !!o);
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    if (o.type !== 'assistant') continue;
    for (const b of blocks(o.message?.content).slice().reverse()) {
      const msg = b?.type === 'tool_use' && b.name === 'SubagentHandback' ? b.input?.message : undefined;
      if (typeof msg === 'string') return { text: msg, from: 'handback' };
    }
  }
  // No handback: the last answer with text, its lines (same message.id) put together in order.
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    if (o.type !== 'assistant' || o.isApiErrorMessage) continue;
    const texts = blocks(o.message?.content).filter((b) => b?.type === 'text' && b.text?.trim());
    if (!texts.length) continue;
    const id = o.message?.id;
    const parts: string[] = [];
    for (let j = i; j >= 0; j--) {
      const r = records[j];
      if (r.type !== 'assistant') continue;
      if (j !== i && (!id || r.message?.id !== id)) break;
      parts.unshift(
        ...blocks(r.message?.content)
          .filter((b) => b?.type === 'text' && b.text?.trim())
          .map((b) => b.text as string),
      );
    }
    return { text: parts.join('\n\n'), from: 'lastText' };
  }
  return null;
}

function main(argv: string[]): number {
  const pos: string[] = [];
  const configs: string[] = [];
  let name = 'REPORT.md';
  let session: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--name' || a === '--session' || a === '--config') {
      const v = argv[++i];
      if (!v) {
        console.error(USAGE);
        return 2;
      }
      if (a === '--name') name = v;
      else if (a === '--session') session = v;
      else configs.push(v);
    } else if (a.startsWith('--')) {
      console.error(`모르는 옵션: ${a}\n${USAGE}`);
      return 2;
    } else pos.push(a);
  }
  if (pos.length !== 2 || path.basename(name) !== name) {
    console.error(USAGE);
    return 2;
  }
  const agentId = normalizeAgentId(pos[0]);
  const folder = path.resolve(pos[1]);
  const file = findSubagentTranscript(configDirs(configs), agentId, { projectFolder: projectFolderName(PROJECT_ROOT), session });
  if (!file) {
    console.error(`서브에이전트 ${agentId}의 대화 기록(subagents/agent-${agentId}.jsonl)을 못 찾았어요. 아직 시작 전이거나 다른 설정 폴더면 --config로 알려 주세요.`);
    return 2;
  }
  const report = subagentReport(fs.readFileSync(file, 'utf8').split('\n'));
  if (!report || !report.text.trim()) {
    console.error(`서브에이전트 ${agentId}의 보고가 아직 없어요(SubagentHandback도 글 답도 없음): ${file}`);
    return 2;
  }
  const dest = path.join(folder, name);
  if (fs.existsSync(dest)) {
    const now = fs.readFileSync(dest, 'utf8');
    if (now === report.text) {
      console.log(`이미 같음: ${dest}`);
      return 0;
    }
    if (!force) {
      console.error(`이미 다른 내용의 ${name}이 있어 쓰지 않았어요: ${dest} (덮어쓰려면 --force)`);
      return 1;
    }
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(dest, report.text, 'utf8');
  console.log(`저장: ${dest}`);
  console.log(`출처: ${file} (${report.from === 'handback' ? 'SubagentHandback 보고' : 'SubagentHandback이 없어 마지막 답의 글'}, ${report.text.length}자)`);
  return 0;
}

if (path.basename(process.argv[1] ?? '') === 'subagent-report.ts') {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
