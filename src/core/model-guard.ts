/**
 * The tests' "no model calls" mark (test/env.ts sets it for every test process and what it starts). Everything that
 * starts claude or a run-job (a real model call: the user's quota, run-job's call log, session records) refuses while it
 * is set, so a test that forgot its fake fails instead of calling out. Without the mark nothing changes.
 * The PowerShell side refuses in scripts/lib/common.ps1 Get-ClaudeExe.
 */
export const NO_MODEL_ENV = 'SECRETARY_NO_MODEL_CALLS';

/** Throws while the mark is set; `what` names the call refused. */
export function assertModelCallsAllowed(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[NO_MODEL_ENV]) throw new Error(`시험 중에는 claude·run-job을 부르지 않아요(${NO_MODEL_ENV}): ${what}. 시험에 가짜를 넣는다.`);
}
