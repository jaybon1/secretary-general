/**
 * Running scripts/run-job/run-job.ps1 from TypeScript: the staff (src/staff/<name>.json), the board rewrite and the
 * consolidation, each with `-Staff <name>`; their model and tools are in the staff member's file, not here.
 */
import { execFile } from 'node:child_process';
import { assertModelCallsAllowed } from '../core/no-model-calls.ts';
import { scriptPath } from '../core/paths.ts';

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

/** run-job's output without the trailing "(새 세션) 세션: …" / "(재사용) 세션: …" line (also the reuse label before 2026-11-11). */
export function stripSessionLine(output: string): string {
  return output.replace(/\n?\((?:새 세션|재사용|이어 부름)\) 세션:.*$/s, '').trim(); // legacy-name: session-reuse-words
}
