/**
 * The secretary's PreToolUse hook (feature 'mistake-guards', .claude/settings.json): a file written, or a shell command, that
 * would put something new directly under the results' parent folder or into its temp folder is refused with the reason
 * (folder-place.ts); a subagent brief (Agent) that asks for a report file is refused too (reportFileBriefProblem). Started on its own (`node src/mistake-guards/pre-tool-hook.ts`, JSON on stdin), not through src/cli.ts,
 * so a tool call waits only for this small file and features.json. Anything it cannot read lets the call through.
 * A refusal is noted for the turn record (tool-hook-hits.ts).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commandPlaceProblem, writePlaceProblem } from './folder-place.ts';
import { readGuardSettings } from './mistake-guard-settings.ts';
import { noteToolHookHit } from './tool-hook-hits.ts';
import { noteHookError } from '../core/hook-errors.ts';

interface PreToolInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string; prompt?: string };
  cwd?: string;
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
const AGENT_TOOLS = /^(Agent|Task)$/;

/** A report file named in a brief. */
const REPORT_FILE_WORD = /\bREPORT\.md\b|보고서?\s*파일|report\s+file/i;
/** A Korean verb comes after its object (the file); an English one before. */
const WRITE_WORD_KO = /써|쓰라|쓰고|작성|저장|남겨|남기/;
const WRITE_WORD_EN = /\b(?:write|save)\b/i;
/** A sentence that says the subagent does not write it, someone else does, or only reads one. */
const NOT_ASKING = /않|말고|마라|말라|막히|막는|막아|막으|금지|비서가|대신|읽|열어|열고|\bnot\b|n't\b|\bnever\b/i;

/**
 * Why a subagent brief fails as written: it asks the subagent to write its report to a file (REPORT.md). Claude Code stops a
 * subagent writing REPORT.md and takes its report as its last answer only, so the subagent stalls or reports that it could
 * not; the secretary saves the last answer itself (scripts/subagent-report). Read sentence by sentence: one saying the
 * secretary saves it, or not to write it, passes.
 */
export function reportFileBriefProblem(prompt: string): string | null {
  for (const s of prompt.split(/\n|(?<=[.!?。])\s+/)) {
    const at = s.search(REPORT_FILE_WORD);
    if (at >= 0 && (WRITE_WORD_KO.test(s.slice(at)) || WRITE_WORD_EN.test(s)) && !NOT_ASKING.test(s)) {
      return `서브에이전트 지시에 보고서 파일 쓰기가 들어 있다("${s.trim().slice(0, 80)}"). Claude Code가 서브에이전트의 REPORT.md 쓰기를 막아 그 지시는 실패한다. "보고는 마지막 답으로만 하라"로 바꾸고, 보고 파일이 필요하면 비서가 받은 보고를 subagent-report로 REPORT.md에 저장한다(delegate 스킬 지시 양식).`;
    }
  }
  return null;
}

/**
 * The same for a brief the prompt hands over as a file ("먼저 C:\…\BRIEF.md를 읽고 그 지시를 따르라"): each absolute .md
 * path in the prompt that is there (and small) is read too.
 */
function briefFilesProblem(prompt: string): string | null {
  for (const m of prompt.matchAll(/[A-Za-z]:[\\/][^\s"'`<>|*?]*?\.md\b/g)) {
    try {
      const file = m[0];
      if (fs.statSync(file).size > 200_000) continue;
      const why = reportFileBriefProblem(fs.readFileSync(file, 'utf8'));
      if (why) return `${file}: ${why}`;
    } catch {
      // Not there or not readable: nothing to read.
    }
  }
  return null;
}

/** Why the call is refused; null to let it through. */
export function preToolProblem(input: PreToolInput, aiRoot: string, existing?: Set<string>): string | null {
  const name = input.tool_name ?? '';
  const cwd = input.cwd || process.cwd();
  if (AGENT_TOOLS.test(name)) {
    const prompt = String(input.tool_input?.prompt ?? '');
    return reportFileBriefProblem(prompt) ?? briefFilesProblem(prompt);
  }
  if (WRITE_TOOLS.test(name)) {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    return file ? writePlaceProblem(file, { aiRoot, cwd, existing }) : null;
  }
  if (SHELL_TOOLS.test(name)) {
    const cmd = String(input.tool_input?.command ?? '');
    return cmd ? commandPlaceProblem(cmd, { aiRoot, cwd, existing }) : null;
  }
  return null;
}

export function denyOutput(reason: string, label = '폴더 위치 규칙'): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[${label}] ${reason}` } });
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let input: PreToolInput = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as PreToolInput;
  } catch {
    return;
  }
  const s = readGuardSettings();
  if (!s.on) return;
  const reason = preToolProblem(input, s.aiRoot);
  if (!reason) return;
  const brief = AGENT_TOOLS.test(input.tool_name ?? '');
  process.stdout.write(denyOutput(reason, brief ? '서브에이전트 지시' : undefined));
  noteToolHookHit(input.session_id, { hook: 'PreToolUse', check: brief ? 'report-file-brief' : 'folder-place', level: 'block', tool: input.tool_name ?? '' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The call goes through either way; the failure is recorded (core/hook-errors.ts).
  main().catch((err) => noteHookError('pre-tool', err));
}
