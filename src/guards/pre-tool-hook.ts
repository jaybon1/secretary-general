/**
 * The secretary's PreToolUse hook (feature 'guards', .claude/settings.json): a file written, or a shell command, that
 * would put something new directly under the results' parent folder or into its temp folder is refused with the reason
 * (folder-place.ts). Started on its own (`node src/guards/pre-tool-hook.ts`, JSON on stdin), not through src/cli.ts,
 * so a tool call waits only for this small file and features.json. Anything it cannot read lets the call through.
 */
import { pathToFileURL } from 'node:url';
import { commandPlaceProblem, writePlaceProblem } from './folder-place.ts';
import { readGuardSettings } from './settings.ts';

interface PreToolInput {
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
  cwd?: string;
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;

/** Why the call is refused; null to let it through. */
export function preToolProblem(input: PreToolInput, aiRoot: string, existing?: Set<string>): string | null {
  const name = input.tool_name ?? '';
  const cwd = input.cwd || process.cwd();
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

export function denyOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[폴더 위치 규칙] ${reason}` } });
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
  if (reason) process.stdout.write(denyOutput(reason));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}
