/**
 * The work-session watcher's verdict (scripts/worker/watch-worker.ps1), made in one place:
 * `node src/cli.ts worker-status <config folder> <work session id> [--claude <exe>] [--prev <signature>]` prints one JSON line.
 *
 * It gathers what the scripts used to read one by one: the session's entry in `claude agents --json`, its job file
 * (`<config>/jobs/<short id>/state.json`, written by the background service), its transcript (core/transcript.ts) and,
 * only when those say nothing, the end of the `claude logs` screen. From them it says whether the session is
 * gone from the list, stopped at an approval prompt, resting (turn ended, with the background commands still left),
 * or working, and how far it has written (a signature to compare with the last one).
 * The watcher keeps what only it can see: this PC's child-command CPU, the result folders, the external devices,
 * the quiet timer, and the notice heads the secretary and the hooks read ("승인 대기:", "idle(대기):", …).
 *
 * Approval, seen with Claude Code 2.1.322 and 2.1.325: the list entry says `status: "waiting"`, `waitingFor: "permission prompt"`
 * (`state: "blocked"`), and the job file `tempo: "blocked"`, `state: "working"`, `needs: "approve <tool>: …"`. A resting
 * session says `status: "idle"` (no waitingFor) and `tempo: "idle"`, `state: "done"`. The transcript has no line for a
 * pending prompt: it ends on the tool call, the same as a tool still running. The screen's prompt text sat 33 lines up
 * from its end (blank lines below it), past the 30 lines the watcher used to read.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertModelCallsAllowed } from '../core/no-model-calls.ts';
import { findSessionTranscript, lastSteps, parseLines, tailLines, transcriptActivity, WORKER_TAIL_BYTES } from '../core/transcript.ts';
import { formatLocal } from '../core/kst-time.ts';
import { lastAnswerAsks } from './worker-asking.ts';

/** One entry of `claude agents --json`, as far as it is read here. A background entry whose service is off may carry only id and state. */
export interface AgentEntry {
  id?: string;
  sessionId?: string;
  pid?: number;
  cwd?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  state?: string;
}

/** A work session's job file, as far as it is read here. tempo: active | idle | blocked; state: working | done | blocked; fan: background commands. */
export interface WorkerJob {
  tempo?: string;
  state?: string;
  intent?: string;
  needs?: string;
  cwd?: string;
  fan?: { id?: string; kind?: string; label?: string }[] | null;
}

export type Verdict = 'gone' | 'approval' | 'rest' | 'working';

export interface WorkerStatus {
  verdict: Verdict;
  id: string;
  /** From the list entry; '' when it has none. */
  sessionId: string;
  pid: number | null;
  cwd: string;
  status: string;
  state: string;
  waitingFor: string;
  /** What said "approval": the list (status/waitingFor), the job file (tempo blocked, state working), or the screen text. */
  approvalBy?: 'list' | 'job' | 'screen';
  /** What the prompt waits for, when known (the job file's needs, else the list's waitingFor). */
  approvalNeeds?: string;
  /** At rest: the state that says so (the job file's when the list says busy or nothing, else the list's). */
  restState?: string;
  /** At rest: background commands still left (they keep the list at busy), one line each. */
  leftover: string[];
  /** At rest: the last answer starts with [질문] (worker-asking then puts the task to asking). */
  asks: boolean;
  /** Changes whenever the session writes: 'jsonl:<…>' from the transcript, 'screen:<hash>' from the screen when no transcript, 'none' when neither ('' when gone). */
  signature: string;
  /** The signature differs from --prev (or there was none). */
  progressed: boolean;
  /** Which of the three the signature and the summary came from. */
  source: 'jsonl' | 'screen' | 'none';
  /** The job file's instruction (the watcher finds the task's result folder in it). */
  intent: string;
  /** Lines for a notice: the last write, the last tool and text from the transcript; else the screen's last lines. */
  summary: string[];
  /** Notes on what was odd (no status in the list entry, no job file, …), for the notice. */
  notes: string[];
}

/** The text a work-session screen shows at an approval prompt. */
const APPROVAL_SCREEN = /Do you want to proceed|requires approval/;
/** Screen lines (blank ones left out) looked at for the prompt text. */
const SCREEN_LINES = 30;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The entry of `claude agents --json` for `id`: the one place the work-session scripts and the watcher match an id
 * (`node src/cli.ts worker-agent`, worker-lib.ps1 Get-WorkerAgent). "bg:" in front is dropped, case is ignored. In order:
 * 1. its id or sessionId is exactly `id`;
 * 2. its id or sessionId starts with `id` (a short id, or the head of a uuid);
 * 3. its name is exactly `id`.
 * When several match at the same step, the first in the list wins (as the scripts always took). Returns the entry as the list
 * gave it (every field kept); null when none matches, `id` is empty or the list is not a list.
 */
export function findAgent(agents: unknown, id: string): AgentEntry | null {
  const want = id.replace(/^bg:/i, '').trim().toLowerCase();
  if (!want || !Array.isArray(agents)) return null;
  const entries = (agents as unknown[]).filter((a): a is AgentEntry => !!a && typeof a === 'object' && !Array.isArray(a));
  const keys = (a: AgentEntry) => [str(a.id).toLowerCase(), str(a.sessionId).toLowerCase()].filter(Boolean);
  return (
    entries.find((a) => keys(a).includes(want)) ??
    entries.find((a) => keys(a).some((k) => k.startsWith(want))) ??
    entries.find((a) => str(a.name).trim().toLowerCase() === want) ??
    null
  );
}

/** `<config>/jobs/<short id>/state.json`; null when it is missing or unreadable. */
export function readWorkerJob(configDir: string, id: string): WorkerJob | null {
  const short = id.replace(/^bg:/, '').trim().toLowerCase().slice(0, 8);
  if (!short) return null;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(configDir, 'jobs', short, 'state.json'), 'utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as WorkerJob) : null;
  } catch {
    return null;
  }
}

/** The screen text without colour codes, its blank lines left out. */
export function screenLines(screen: string): string[] {
  return screen
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
}

/**
 * The screen's end as text to compare, without what changes on every redraw (clock, elapsed time, usage line):
 * a stalled session's spinner keeps counting. Numbers that mean progress (token counts) stay.
 */
export function screenSignature(screen: string): string {
  const out: string[] = [];
  for (let l of screenLines(screen).slice(-SCREEN_LINES)) {
    if (/\d+h \d+%|초기화 \d|auto mode|shift\+tab/.test(l)) continue;
    l = l.replace(/(오전|오후|AM|PM)\s*\d{1,2}:\d{2}(:\d{2})?/g, '');
    l = l.replace(/\b\d+(\.\d+)?\s*(h|m|s|ms|초|분|시간)(?![A-Za-z가-힣])/g, '');
    l = l.trim();
    if (l) out.push(l);
  }
  return out.join('\n');
}

/** Background commands still running, one line each ("shell b1: npm test"), labels cut at 80 characters. */
function leftoverOf(job: WorkerJob | null): string[] {
  const fan = Array.isArray(job?.fan) ? job.fan : [];
  return fan
    .filter((f) => f && typeof f === 'object')
    .map((f) => {
      let label = str(f.label).replace(/\s+/g, ' ');
      if ([...label].length > 80) label = `${[...label].slice(0, 80).join('')}…`;
      return `${str(f.kind)} ${str(f.id)}: ${label}`;
    });
}

/**
 * The verdict from the list entry and the job file, before the screen:
 * 1. status waiting (any waitingFor) → approval (the session waits for a person; "permission prompt" is what was seen);
 * 2. job file tempo blocked + state working, unless the list says idle → approval;
 * 3. status busy → rest when the model rests and has an answer or question out (tempo idle|blocked, state done|blocked):
 *    a background command left over keeps the list at busy; else working;
 * 4. another status (idle, …) → rest;
 * 5. no status (a background entry whose service seems off): rest when the entry or the job says done|blocked, else
 *    null (the caller looks at the screen, then counts it as working).
 */
export function judge(agent: AgentEntry, job: WorkerJob | null): { verdict: 'approval' | 'rest' | 'working'; by?: 'list' | 'job' } | null {
  const status = str(agent.status);
  const jobBlocked = job?.tempo === 'blocked' && job?.state === 'working';
  if (status === 'waiting' || str(agent.waitingFor) === 'permission prompt') return { verdict: 'approval', by: 'list' };
  if (jobBlocked && status !== 'idle') return { verdict: 'approval', by: 'job' };
  if (status === 'busy') {
    const rests = !!job && ['idle', 'blocked'].includes(str(job.tempo)) && ['done', 'blocked'].includes(str(job.state));
    return { verdict: rests ? 'rest' : 'working' };
  }
  if (status) return { verdict: 'rest' };
  if (['done', 'blocked'].includes(str(agent.state)) || ['done', 'blocked'].includes(str(job?.state))) return { verdict: 'rest' };
  return null;
}

export interface StatusInput {
  configDir: string;
  id: string;
  /** The parsed output of `claude agents --json` (the config folder's list). */
  agents: unknown;
  /** The `claude logs` screen, read only when asked (it is slow); null when it cannot be read. */
  readScreen?: () => string | null;
  prevSignature?: string;
}

export function workerStatus(input: StatusInput): WorkerStatus {
  const { configDir } = input;
  const id = input.id.replace(/^bg:/, '').trim();
  let screen: string | null | undefined;
  const getScreen = (): string | null => {
    if (screen === undefined) screen = input.readScreen?.() ?? null;
    return screen;
  };
  const agent = findAgent(input.agents, id);
  const out: WorkerStatus = {
    verdict: 'gone', id, sessionId: str(agent?.sessionId), pid: typeof agent?.pid === 'number' ? agent.pid : null,
    cwd: str(agent?.cwd), status: str(agent?.status), state: str(agent?.state), waitingFor: str(agent?.waitingFor),
    leftover: [], asks: false, signature: '', progressed: false, source: 'none', intent: '', summary: [], notes: [],
  };
  if (!agent) return out;
  const job = readWorkerJob(configDir, str(agent.id) || id);
  out.intent = str(job?.intent);
  if (!out.cwd) out.cwd = str(job?.cwd);
  if (!out.status) out.notes.push('목록 항목에 status가 없어요(백그라운드 서비스가 꺼진 듯해요)');
  if (!job) out.notes.push('작업 상태 파일(state.json)을 못 읽었어요');

  let file: string | null = null;
  try {
    file = findSessionTranscript(configDir, id, out.sessionId || undefined);
  } catch {
    file = null;
  }
  const activity = file ? transcriptActivity(file) : null;
  let lines: string[] = [];
  if (file && activity) {
    try {
      lines = tailLines(file, WORKER_TAIL_BYTES, { wholeOnly: true });
    } catch {
      lines = [];
    }
  }
  const records = parseLines(lines);

  let j = judge(agent, job);
  if (!j) {
    // No status in the list and nothing in the job file: the screen's end is all that is left to see a prompt in.
    const s = getScreen();
    j = s && APPROVAL_SCREEN.test(screenLines(s).slice(-SCREEN_LINES).join('\n')) ? { verdict: 'approval' } : { verdict: 'working' };
    if (j.verdict === 'approval') out.approvalBy = 'screen';
  }
  out.verdict = j.verdict;
  if (j.verdict === 'approval') {
    out.approvalBy ??= j.by;
    const needs = str(job?.needs) || out.waitingFor;
    if (needs) out.approvalNeeds = needs;
  }
  if (j.verdict === 'rest') {
    out.restState = out.status === 'busy' || !out.status ? str(job?.state) || out.state : out.state;
    out.leftover = out.status === 'busy' ? leftoverOf(job) : [];
    out.asks = lines.length > 0 && lastAnswerAsks(lines);
  }

  if (activity) {
    out.source = 'jsonl';
    out.signature = `jsonl:${activity.signature}`;
    const steps = lastSteps(records);
    out.summary.push(`대화 기록 마지막 쓰기: ${formatLocal(activity.lastWriteMs, false, true)} KST${activity.subagents ? ` (서브에이전트 기록 ${activity.subagents}개 포함)` : ''}`);
    if (steps.tool) out.summary.push(`마지막 도구: ${steps.tool}`);
    if (steps.text) out.summary.push(`마지막 글: ${steps.text}`);
  } else {
    const s = getScreen();
    if (s !== null) {
      out.source = 'screen';
      out.signature = `screen:${createHash('sha1').update(screenSignature(s)).digest('hex').slice(0, 16)}`;
      out.summary = screenLines(s).slice(-(out.verdict === 'approval' ? 15 : 10));
    }
    else out.signature = 'none';
    out.notes.push('대화 기록(jsonl)을 못 찾았어요');
  }
  out.progressed = !input.prevSignature || out.signature !== input.prevSignature;
  return out;
}

/** `<claude> logs <id>` (the screen); null when it fails. Not a model call, but tests use a file instead (no claude in tests). */
export function readScreenWith(claude: string, id: string): string | null {
  assertModelCallsAllowed(`${claude} logs`);
  const r = spawnSync(claude, ['logs', id], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
}

/** `<claude> agents --json`, parsed; throws when it fails (the watcher then says it could not read the list). */
export function readAgentsWith(claude: string): unknown {
  assertModelCallsAllowed(`${claude} agents`);
  const r = spawnSync(claude, ['agents', '--json'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude agents --json 실패(코드 ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
  return JSON.parse(r.stdout) as unknown;
}
