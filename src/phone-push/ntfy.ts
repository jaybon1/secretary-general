/**
 * The end notice (feature 'phone-push'): when a turn of the secretary's own session really ends, the Stop hook sends the
 * answer's first line (the conclusion line) to this PC's ntfy server, which a phone subscribes to. No model call, every
 * turn, after the answer is written (the model's PushNotification arrived before the answer and cost a request).
 *
 * Not sent: a turn the answer checks send back (mistake-guards/stop-guard.ts: the rewritten answer ends the turn and is sent
 * then), a subagent's stop (Claude Code fires SubagentStop for those, and a hook input with agent_id is skipped too),
 * tests (the no-model mark, core/no-model-calls.ts), and any copy without the settings section. Work sessions
 * and run-jobs run in other folders, whose settings carry no secretary Stop hook.
 *
 * The POST runs in a detached child process (this file run directly), so the hook ends as fast as before; a failure or
 * timeout there is one line in this secretary's ~/.secretary/<id>/logs/notify.log (LOG_FILE) and nothing else.
 *
 * The phone-push section of this-secretary.local.json (this PC only, not committed, core/this-secretary.ts; none = nothing is sent):
 *   url        the ntfy server, e.g. "http://127.0.0.1:2586" (the hook runs on the server's PC)   required
 *   topic      the topic the phone subscribes to (letters, digits, - and _)                        required
 *   title      the notice title; {session} is the session's name (its /rename title), else 비서    default "{session}"
 *   priority   ntfy priority 1-5 (4 high: pop-over and sound, 5 urgent)                           default 4
 *   click      what tapping the notice opens: "session" (this session's Remote Control conversation,
 *              https://claude.ai/code/session_…, else https://claude.ai/code), an https address,
 *              or false for nothing                                                               default "session"
 *   tokenFile  a file holding an access token (the token alone, or NTFY_TOKEN=…), when the server asks for one
 *   timeoutMs  how long the POST may take                                                        default 2500
 *   enabled    false stops sending without removing the file                                      default true
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../core/config.ts';
import { readJson } from '../core/json-file.ts';
import { readThisSecretary, THIS_SECRETARY_FILE } from '../core/this-secretary.ts';
import { formatLocal } from '../core/kst-time.ts';
import { NO_MODEL_ENV } from '../core/no-model-calls.ts';
import { secretaryLogDir } from '../core/paths.ts';
import { featureOn, readFeatures } from '../core/features.ts';
import { FEATURE } from '../core/names.ts';
import { readLastTurn } from '../mistake-guards/last-turn.ts';

export const FEATURE_ID = FEATURE.phonePush;
export const DEFAULT_TITLE = '비서';
export const DEFAULT_PRIORITY = 4;
/** What a tap opens when this session's conversation address is not known: the Claude app's code page. */
export const CLAUDE_CODE_URL = 'https://claude.ai/code';
/** settings.click for "this session's conversation". */
export const CLICK_SESSION = 'session';
export const MAX_MESSAGE = 200;
/** This secretary's own log (~/.secretary/<its id>/logs/notify.log, core/paths.ts secretaryLogDir). */
export const LOG_FILE = path.join(secretaryLogDir(), 'notify.log');

export interface NotifySettings {
  url: string;
  topic: string;
  title: string;
  priority: number;
  /** "session", a fixed https address, or null for no tap action. */
  click: string | null;
  tokenFile: string | null;
  timeoutMs: number;
}

export interface Notice {
  title: string;
  message: string;
  /** The address a tap opens. */
  click?: string;
}

/** Whether the feature is on in this copy's features.json (on without the file, like every feature). */
export function notifyOn(root = PROJECT_ROOT): boolean {
  const f = (readFeatures(root) ?? []).find((x) => x.id === FEATURE_ID);
  return !f || featureOn(f);
}

/**
 * The settings, or null with no file, enabled false, or a file that cannot be used (problem says why; the install check
 * shows it). A file that cannot be used sends nothing rather than something half right.
 */
export function readNotifySettings(root = PROJECT_ROOT): { settings: NotifySettings | null; problem: string | null } {
  const r = readThisSecretary<Record<string, unknown>>(FEATURE_ID, { root });
  if (!r.ok) return { settings: null, problem: r.missing ? null : `${THIS_SECRETARY_FILE}을 못 읽음(${r.error.slice(0, 80)})` };
  const v = r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
  if (v.enabled === false) return { settings: null, problem: null };
  const problems: string[] = [];
  const url = typeof v.url === 'string' && /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v.url) ? v.url.replace(/\/+$/, '') : null;
  if (!url) problems.push('url은 http(s)://주소 형식');
  const topic = typeof v.topic === 'string' && /^[-_A-Za-z0-9]{1,64}$/.test(v.topic) ? v.topic : null;
  if (!topic) problems.push('topic은 영문·숫자·-·_ 64자 안');
  const int = (k: string, def: number, min: number, max: number) => {
    const x = v[k];
    if (x === undefined) return def;
    if (typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max) return x;
    problems.push(`${k}=${JSON.stringify(x)} 무시`);
    return def;
  };
  const priority = int('priority', DEFAULT_PRIORITY, 1, 5);
  let click: string | null = CLICK_SESSION;
  if (v.click === false || v.click === '') click = null;
  else if (typeof v.click === 'string' && (v.click === CLICK_SESSION || /^https:\/\/\S+$/.test(v.click))) click = v.click;
  else if (v.click !== undefined) problems.push(`click=${JSON.stringify(v.click)} 무시("session", https 주소, false 중 하나)`);
  const timeoutMs = int('timeoutMs', 2500, 200, 10_000);
  const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : '{session}';
  const tokenFile = typeof v.tokenFile === 'string' && v.tokenFile ? path.resolve(root, v.tokenFile) : null;
  if (!url || !topic) return { settings: null, problem: problems.join(', ') };
  return { settings: { url, topic, title, priority, click, tokenFile, timeoutMs }, problem: problems.length ? problems.join(', ') : null };
}

/** The token in tokenFile: the file's text alone, or its NTFY_TOKEN=… line. Null when there is none. */
export function readToken(tokenFile: string | null): string | null {
  if (!tokenFile) return null;
  let text: string;
  try {
    text = fs.readFileSync(tokenFile, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
  const line = /^\s*NTFY_TOKEN\s*=\s*["']?([^"'\s]+)/m.exec(text);
  if (line) return line[1];
  const plain = text.trim();
  return plain && !/[\s=]/.test(plain) ? plain : null;
}

/** Markdown marks off one line: heading, quote, list, bold/italic, code, link brackets. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line that carries nothing to read: rule, fence, table separator, only marks. */
const emptyish = (line: string) => /^\s*(?:[-*_=]{3,}|`{3,}.*|~{3,}.*|\|?[\s:|-]+\|[\s:|-]*)\s*$/.test(line) || !plainLine(line);

/**
 * The answer's first line as the notice body: the conclusion line, markdown marks off, cut to about `max` characters.
 * Quoted head lines ("> 이어서: …" and the like) before it are passed over; an answer of quotes only gives its first.
 */
export function firstLine(answer: string, max = MAX_MESSAGE): string {
  const lines = answer.split(/\r?\n/).filter((l) => !emptyish(l));
  const pick = lines.find((l) => !/^\s*>/.test(l)) ?? lines[0];
  if (!pick) return '';
  const text = plainLine(pick);
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/** The session's name from the transcript's end: its /rename title, else the name it was started with. */
export function sessionName(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    let custom: string | null = null;
    let agent: string | null = null;
    for (const l of text.split('\n')) {
      if (!l.startsWith('{"type":"custom-title"') && !l.startsWith('{"type":"agent-name"')) continue;
      try {
        const o = JSON.parse(l) as { type?: string; customTitle?: unknown; agentName?: unknown };
        if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) custom = o.customTitle.trim();
        if (o.type === 'agent-name' && typeof o.agentName === 'string' && o.agentName.trim()) agent = o.agentName.trim();
      } catch {}
    }
    return custom ?? agent;
  } catch {
    return null;
  }
}

/** Where Claude Code keeps one file per running session (<pid>.json: sessionId, bridgeSessionId when Remote Control is on). */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

/**
 * This session's Remote Control conversation address (https://claude.ai/code/session_…), read from Claude Code's session
 * files by the hook's session id; null when the session is not on Remote Control or the files cannot be read.
 */
export function remoteSessionUrl(sessionId: string | undefined, dir = sessionsDir()): string | null {
  if (!sessionId) return null;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  for (const n of names) {
    const r = readJson<{ sessionId?: unknown; bridgeSessionId?: unknown }>(path.join(dir, n));
    if (!r.ok || r.value?.sessionId !== sessionId) continue;
    const bridge = r.value.bridgeSessionId;
    if (typeof bridge === 'string' && /^session_[A-Za-z0-9]+$/.test(bridge)) return `${CLAUDE_CODE_URL}/${bridge}`;
  }
  return null;
}

/** The address a tap on this session's notice opens, or undefined for none. */
export function clickUrl(settings: NotifySettings, sessionId: string | undefined, dir?: string): string | undefined {
  if (!settings.click) return undefined;
  if (settings.click !== CLICK_SESSION) return settings.click;
  return remoteSessionUrl(sessionId, dir) ?? CLAUDE_CODE_URL;
}

export interface StopNotifyInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  /** Set by Claude Code when the hook fires inside a subagent. */
  agent_id?: string;
  stop_hook_active?: boolean;
}

export interface PlanDeps {
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Instead of reading this PC's phone-push section. */
  settings?: NotifySettings | null;
  /** Instead of reading the transcript (the answer when the checks did not read it). */
  answer?: string;
  /** Claude Code's session files (instead of ~/.claude/sessions). */
  sessionsDir?: string;
}

/**
 * What the Stop hook would send for this turn, or null with why not. The answer is the one the checks read (`verdict.answer`),
 * else the transcript's last turn.
 */
export function planNotice(input: StopNotifyInput, verdict: { block?: string; answer?: string }, deps: PlanDeps = {}): { notice: Notice; settings: NotifySettings } | { skip: string } {
  const env = deps.env ?? process.env;
  const root = deps.root ?? PROJECT_ROOT;
  if (env[NO_MODEL_ENV]) return { skip: 'test run' };
  if (verdict.block) return { skip: 'turn sent back' };
  if (input.agent_id || (input.hook_event_name && input.hook_event_name !== 'Stop')) return { skip: 'not the main session' };
  if (!notifyOn(root)) return { skip: 'feature off' };
  const settings = deps.settings !== undefined ? deps.settings : readNotifySettings(root).settings;
  if (!settings) return { skip: 'no settings' };
  const answer = deps.answer ?? verdict.answer ?? (input.transcript_path ? (readLastTurn(input.transcript_path)?.answer ?? '') : '');
  const message = firstLine(answer);
  if (!message) return { skip: 'empty answer' };
  const title = settings.title.replace(/\{session\}/g, sessionName(input.transcript_path) ?? DEFAULT_TITLE);
  const click = clickUrl(settings, input.session_id, deps.sessionsDir);
  return { notice: { title, message, ...(click ? { click } : {}) }, settings };
}

/** The ntfy JSON publish request (POST to the server root, UTF-8 title and body in JSON). */
export function ntfyRequest(settings: NotifySettings, notice: Notice, token: string | null): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: `${settings.url}/`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic: settings.topic, title: notice.title, message: notice.message, priority: settings.priority, ...(notice.click ? { click: notice.click } : {}) }),
    },
  };
}

/** One line in the notice log (failures only); the log is cut when it grows past 256 KB. Never throws. */
export function logLine(text: string, file = LOG_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${formatLocal(Date.now(), false, true)} ${text}\n`);
  } catch {}
}

/** Sends one notice; true when the server took it. A failure or timeout is logged, never thrown. */
export async function postNotice(settings: NotifySettings, notice: Notice, opts: { token?: string | null; fetchImpl?: typeof fetch; logFile?: string } = {}): Promise<boolean> {
  const { url, init } = ntfyRequest(settings, notice, opts.token ?? null);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(settings.timeoutMs) });
    if (res.ok) return true;
    logLine(`ntfy ${res.status} ${res.statusText}: ${settings.url} ${settings.topic}`, opts.logFile);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    logLine(`ntfy 실패(${e.name === 'TimeoutError' ? `${settings.timeoutMs}ms 시간 초과` : (e.cause?.code ?? e.message)}): ${settings.url} ${settings.topic}`, opts.logFile);
  }
  return false;
}

/** Hands the notice to a detached child (this file run directly), so the hook does not wait for the network. */
export function launchNotice(notice: Notice, root = PROJECT_ROOT): void {
  const arg = Buffer.from(JSON.stringify(notice), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [path.join(root, 'src', 'phone-push', 'ntfy.ts'), arg], { detached: true, stdio: 'ignore', windowsHide: true, cwd: root });
  child.on('error', (err) => logLine(`보내기 프로세스 실패: ${err.message}`));
  child.unref();
}

/** The Stop hook's call: plans and hands off; never throws, never waits. */
export function notifyAfterStop(input: StopNotifyInput, verdict: { block?: string; answer?: string }, deps: PlanDeps & { launch?: (n: Notice) => void; logFile?: string } = {}): void {
  try {
    const plan = planNotice(input, verdict, deps);
    if ('notice' in plan) (deps.launch ?? ((n: Notice) => launchNotice(n, deps.root)))(plan.notice);
  } catch (err) {
    logLine(`알림 준비 실패: ${(err as Error).message}`, deps.logFile);
  }
}

// Run directly by launchNotice: node src/phone-push/ntfy.ts <notice as base64url JSON>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env[NO_MODEL_ENV]) {
      const notice = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8')) as Notice;
      const { settings } = readNotifySettings();
      const click = typeof notice.click === 'string' && /^https:\/\/\S+$/.test(notice.click) ? notice.click : undefined;
      if (settings && typeof notice.message === 'string' && notice.message) {
        await postNotice(settings, { title: String(notice.title ?? DEFAULT_TITLE), message: notice.message, ...(click ? { click } : {}) }, { token: readToken(settings.tokenFile) });
      }
    }
  } catch (err) {
    logLine(`보내기 실패: ${(err as Error).message}`);
  }
}
