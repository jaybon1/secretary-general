/** Running scripts/run-job/run-job.ps1 from TypeScript (the board rewrite and the idle consolidation). */
import { execFile } from 'node:child_process';
import { assertModelCallsAllowed } from '../core/model-guard.ts';
import { scriptPath } from '../core/paths.ts';

/** Account a (the secretary's own subscription), Haiku medium, a fresh session: decided 2026-11-05 for the idle jobs. */
export const IDLE_MODEL_ARGS = ['-Provider', 'subscription', '-Model', 'haiku', '-Effort', 'medium', '-New'];

/** Runs scripts/run-job/run-job.ps1 with `jobArgs` and the prompt file; resolves with what it printed. */
export function runJobScript(jobArgs: string[], promptFile: string, timeoutMs: number): Promise<string> {
  const script = scriptPath('runJob');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...jobArgs, '-PromptFile', promptFile];
  return new Promise((resolve, reject) => {
    assertModelCallsAllowed(`run-job.ps1 ${jobArgs.join(' ')}`);
    // On failure keep what claude said (stderr, or the result printed on stdout), not the long command line.
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr.trim() || stdout.trim() || err.message).slice(0, 500))) : resolve(stdout),
    );
  });
}

/** run-job's output without the trailing "(새 세션) 세션: …" / "(이어 부름) 세션: …" line. */
export function stripSessionLine(output: string): string {
  return output.replace(/\n?\((?:새 세션|이어 부름)\) 세션:.*$/s, '').trim();
}
