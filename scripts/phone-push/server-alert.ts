/**
 * The secretary server's stuck states, told to the phone once (feature 'phone-push', the same ntfy settings as the end notice:
 * src/phone-push/ntfy.ts). The server window (scripts/remote-server/remote-server.ps1) calls it when Claude's login is gone
 * or the server keeps restarting without connecting; the user mostly uses the secretary from a phone, where the server
 * only shows as offline, with no reason.
 *
 *   node scripts/phone-push/server-alert.ts --state <file> --server <name> --problem login|restart-loop [--exit-code <n>]
 *   node scripts/phone-push/server-alert.ts --state <file> --clear login|restart-loop|all
 *
 * Once per stuck state: the state file (one per server, beside its log) keeps the problem last sent, and the same problem
 * is not sent again until --clear takes it away (the window clears it when the login is back or the server connects). The
 * file is written only after the server took the notice, so a notice that did not go out is tried again on the next call.
 * Nothing is sent with the feature off, without the phone-push settings, or in a test run (the no-model mark). Prints one
 * line for the server log; never fails the window (exit 0).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../../src/core/config.ts';
import { NO_MODEL_ENV } from '../../src/core/no-model-calls.ts';
import { clickUrl, notifyOn, postNotice, readNotifySettings, readToken, type Notice, type NotifySettings } from '../../src/phone-push/ntfy.ts';
import { readJsonStrict } from '../../src/core/json-file.ts';

export const SERVER_PROBLEMS = ['login', 'restart-loop'] as const;
export type ServerProblem = (typeof SERVER_PROBLEMS)[number];
/** How long the server may keep restarting without connecting before the window calls restart-loop (remote-server.ps1 uses the same). */
export const RESTART_LOOP_MINUTES = 15;

interface AlertState {
  problem: ServerProblem;
  at: string;
}

function readState(file: string): AlertState | null {
  try {
    const v = readJsonStrict(file) as Partial<AlertState>;
    return v && (SERVER_PROBLEMS as readonly string[]).includes(v.problem as string) ? (v as AlertState) : null;
  } catch {
    return null;
  }
}

/** What the phone gets for a problem of server `server`. */
export function serverNotice(server: string, problem: ServerProblem, exitCode?: string): Notice {
  const message =
    problem === 'login'
      ? `${server} 서버가 멈췄어요: Claude 로그인이 풀렸어요. 이 PC에서 새 터미널을 열고 claude auth login을 실행해 주세요(로그인하면 5분 안에 서버가 다시 켜져요).`
      : `${server} 서버가 ${RESTART_LOOP_MINUTES}분 넘게 연결되지 못하고 다시 켜지기를 되풀이해요${exitCode ? `(마지막 종료 코드 ${exitCode})` : ''}. 서버 기록을 봐 주세요: scripts\\remote-server\\server-control.ps1 -Action log`;
  return { title: server, message };
}

export interface AlertDeps {
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Instead of this PC's phone-push section. */
  settings?: NotifySettings | null;
  /** Instead of the POST (a test). */
  send?: (settings: NotifySettings, notice: Notice) => Promise<boolean>;
  now?: number;
}

/** One problem: sent when it is not the one already sent, and then kept in the state file. Returns the line for the log. */
export async function alertServer(stateFile: string, server: string, problem: ServerProblem, exitCode: string | undefined, d: AlertDeps = {}): Promise<string> {
  const env = d.env ?? process.env;
  const root = d.root ?? PROJECT_ROOT;
  if (readState(stateFile)?.problem === problem) return `이미 알림(${problem}): 같은 상태라 다시 보내지 않음`;
  if (env[NO_MODEL_ENV]) return '안 보냄: 시험 실행';
  if (!notifyOn(root)) return '안 보냄: 기능 phone-push 꺼짐';
  const settings = d.settings !== undefined ? d.settings : readNotifySettings(root).settings;
  if (!settings) return '안 보냄: phone-push 설정 없음';
  const click = clickUrl(settings, undefined);
  const notice = { ...serverNotice(server, problem, exitCode), ...(click ? { click } : {}) };
  const sent = await (d.send ?? ((s, n) => postNotice(s, n, { token: readToken(s.tokenFile) })))(settings, notice);
  if (!sent) return `못 보냄(${problem}): ntfy가 받지 않음(notify.log), 다음에 다시 시도`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ problem, at: new Date(d.now ?? Date.now()).toISOString() }));
  } catch (err) {
    return `보냄(${problem}), 상태 파일은 못 씀(${(err as Error).message}): 다음에 또 보낼 수 있음`;
  }
  return `보냄(${problem})`;
}

/** The state is over: `problem` (or any with 'all') is taken away, so the next time it comes it is sent again. */
export function clearServerAlert(stateFile: string, problem: ServerProblem | 'all'): string {
  const s = readState(stateFile);
  if (!fs.existsSync(stateFile)) return '';
  if (s && problem !== 'all' && s.problem !== problem) return '';
  try {
    fs.rmSync(stateFile, { force: true });
    return `풀림(${s?.problem ?? '알 수 없는 상태'})`;
  } catch (err) {
    return `상태 파일을 못 지움: ${(err as Error).message}`;
  }
}

/** The command line; the line to print, or a usage error. */
export async function main(argv: string[], d: AlertDeps = {}): Promise<{ line: string; ok: boolean }> {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const usage = { line: 'usage: server-alert.ts --state <file> (--server <name> --problem login|restart-loop [--exit-code <n>] | --clear login|restart-loop|all)', ok: false };
  const state = opt('--state');
  if (!state) return usage;
  const clear = opt('--clear');
  if (clear !== undefined) {
    if (clear !== 'all' && !(SERVER_PROBLEMS as readonly string[]).includes(clear)) return usage;
    return { line: clearServerAlert(state, clear as ServerProblem | 'all'), ok: true };
  }
  const problem = opt('--problem');
  const server = opt('--server');
  if (!server || !problem || !(SERVER_PROBLEMS as readonly string[]).includes(problem)) return usage;
  return { line: await alertServer(state, server, problem as ServerProblem, opt('--exit-code'), d), ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await main(process.argv.slice(2));
    if (r.line) console.log(r.line);
    if (!r.ok) process.exitCode = 2;
  } catch (err) {
    console.log(`알림 실패: ${(err as Error).message}`);
  }
}
