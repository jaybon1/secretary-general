/**
 * Install check: is everything the README installs actually in place on this PC?
 *
 * The session-start hook runs the full check and, only when something is missing, injects a
 * <secretary-setup> notice with what is missing, how to fix it and what the secretary does about
 * it. A complete install injects nothing. The rule rides along with the notice, so it costs
 * nothing in AGENTS.md (same idea as <secretary-embedder>).
 *
 * Files are looked at directly (milliseconds). Scheduled tasks and processes need Windows:
 * one schtasks.exe per task (~60 ms, in parallel) and one PowerShell WMI query for the processes
 * (~1.7-2.2 s on one PC, nearly all PowerShell's own start-up), started before the hook's
 * other work so they overlap. When the last check found the server window, its pid
 * is kept and only confirmed (tasklist per pid, ~0.2 s); anything short of that gets the full
 * query. A query that fails or runs out of time leaves its items "unknown", which never fails the
 * hook and never raises the notice on its own. So does an answer that may only mean "not allowed":
 * a process whose command line could not be read (a window started with higher rights), or a
 * schtasks failure that is not its plain "no such task" message.
 *
 * The full result is kept next to the database. The prompt hook re-reads it, looks at the files
 * again (a mid-session `npm install` counts at once) and, while something is still missing, adds
 * a one-line reminder: the secretary is to open every answer with it. Tasks and processes keep
 * the session-start answer until `node src/cli.ts setup-check` checks again.
 *
 * The checks are what any copy of the secretary needs (one server, one subscription).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT } from './config.ts';
import { MODEL_FILES, MODEL_PATH } from './semantic.ts';

export const SERVER_TASK = 'Secretary Remote Control';
export const BACKUP_TASK = 'Secretary DB Backup';
/** Each probe (schtasks, PowerShell) gives up after this; its items are then "unknown". */
const PROBE_TIMEOUT_MS = 5000;

export type Status = 'ok' | 'missing' | 'unknown';

export interface CheckResult {
  id: string;
  label: string;
  status: Status;
  detail?: string;
  /** How to fix it; only on missing items. */
  fix?: string;
}

export interface SetupReport {
  checkedAt: string;
  /** Wall time of the whole check. */
  ms: number;
  results: CheckResult[];
  /** The processes every process item was found on, kept only when all of them were ok (ProbeQuery.known). */
  procs?: Proc[];
}

/** What is kept next to the database: the last full check, and items the user chose to go without. */
export interface SetupCache extends SetupReport {
  skip: string[];
}

export interface Proc {
  pid: number;
  /** Image name, e.g. powershell.exe. */
  name: string;
  exe: string | null;
  cmd: string | null;
}

export interface ProbeQuery {
  tasks: string[];
  /** Image names (powershell.exe, python.exe, …) whose processes to list. */
  images: string[];
  /**
   * The processes the last check found everything running on. If each pid still runs under the
   * same image name (tasklist, ~0.1 s), they stand in for the PowerShell list (~1.7 s).
   */
  known?: Proc[];
}

export interface Probe {
  /** Registered or not; null when the query failed. */
  tasks: Record<string, boolean | null>;
  /** null when the process query failed or ran out of time. */
  procs: Proc[] | null;
  /** procs are the known ones, confirmed alive, not a fresh list. */
  reused?: boolean;
}

export interface SetupOptions {
  root: string;
  dbPath: string;
  modelPath: string;
  platform: NodeJS.Platform;
  /** Whether the database was there before this process opened it (openDb creates a missing one). */
  dbExisted?: boolean;
  probe: (q: ProbeQuery) => Promise<Probe>;
  cacheFile: string;
}

export function setupOptions(over: Partial<SetupOptions> = {}): SetupOptions {
  const dbPath = over.dbPath ?? DB_PATH;
  return {
    root: PROJECT_ROOT,
    modelPath: MODEL_PATH,
    platform: process.platform,
    probe: probeWindows,
    cacheFile: `${dbPath}.setup.json`,
    ...over,
    dbPath,
  };
}

const disabled = () => process.env.SECRETARY_SETUP_CHECK === 'off';

interface Outcome {
  status: Status;
  detail?: string;
  /** The processes an ok rests on. */
  procs?: Proc[];
}

interface Ctx {
  o: SetupOptions;
  probe: Probe | null;
}

interface Check {
  id: string;
  /** Short: it goes into the one line that opens every answer. */
  label: string;
  fix: string;
  /** Windows only (task scheduler, PowerShell scripts). */
  windows?: boolean;
  /** Needs the probe; such checks run only in the full check (session start, setup-check). */
  probe?: (o: SetupOptions) => Partial<ProbeQuery>;
  applies?: (o: SetupOptions) => boolean;
  run: (c: Ctx) => Outcome;
}

/** The model files the first automatic download leaves; it skips special_tokens_map.json, which loading does not need. */
export const LOADED_MODEL_FILES = MODEL_FILES.filter((f) => f !== 'special_tokens_map.json');

const ok: Outcome = { status: 'ok' };
const missingOf = (names: string[]): Outcome => (names.length ? { status: 'missing', detail: names.join(', ') } : ok);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

function taskOutcome(c: Ctx, name: string): Outcome {
  const registered = c.probe?.tasks[name];
  if (registered === true) return ok;
  if (registered === false) return { status: 'missing' };
  return { status: 'unknown', detail: '예약 작업 조회 실패' };
}

/** The window running this copy's scripts/remote-server.ps1. */
export function serverWindow(procs: Proc[], root: string): Proc | undefined {
  const script = path.win32.join(root, 'scripts', 'remote-server.ps1').toLowerCase();
  return procs.find((p) => {
    const cmd = p.cmd?.toLowerCase() ?? '';
    return /(^|[\\/"])(powershell|pwsh)\.exe"?\s/.test(cmd) && cmd.includes(script);
  });
}

/** What every copy of the secretary needs. */
export const CHECKS: Check[] = [
  {
    id: 'db',
    label: '기억 DB',
    fix: '처음 설치라면 정상(빈 DB를 새로 만들었고 대화하며 채워진다). 기억이 있던 PC라면 `SECRETARY_DB` 경로나 `backups/`의 백업을 확인',
    run: ({ o }) => ((o.dbExisted ?? fs.existsSync(o.dbPath)) ? ok : { status: 'missing', detail: `${o.dbPath} 없음` }),
  },
  {
    id: 'packages',
    label: '패키지(npm install)',
    fix: '비서 폴더에서 `npm install` (README 설치 2단계). 없으면 기억 서버(MCP)가 뜨지 않는다',
    run: ({ o }) => {
      const deps = Object.keys(readJson<{ dependencies?: Record<string, string> }>(path.join(o.root, 'package.json'))?.dependencies ?? {});
      return missingOf(deps.filter((d) => !fs.existsSync(path.join(o.root, 'node_modules', d, 'package.json'))));
    },
  },
  {
    id: 'model',
    label: '의미 검색 모델 파일',
    fix: '처음 쓰는 PC면 정상: 첫 질문 때 도우미가 `models/`에 자동으로 받는다(약 570MB, 1분 남짓, 그동안은 단어 검색만). 받은 뒤에도 그대로면 인터넷 연결을 확인하고 `node scripts/watch-embedder.mjs --retry`로 다시 띄운다(README "의미 검색")',
    applies: () => process.env.SECRETARY_EMBED !== 'off',
    run: ({ o }) => missingOf(LOADED_MODEL_FILES.filter((f) => !fs.existsSync(path.join(o.modelPath, f)))),
  },
  {
    id: 'server-task',
    label: '비서 서버 자동 시작 예약 작업',
    fix: `README 설치 7번(선택): 처음 한 번 \`claude auth login\` 후 비서 폴더에서 \`claude remote-control\`을 직접 실행해 \`y\`로 답하고, 관리자 PowerShell에서 \`scripts/install-autostart.ps1\`. 다른 기기에서 쓰지 않으면 빼 둔다. 없으면 로그인할 때 서버가 안 떠 다른 기기에서 새 비서 세션을 못 열고, 열린 세션만 Remote Control로 쓰면 자주 끊긴다`,
    windows: true,
    probe: () => ({ tasks: [SERVER_TASK] }),
    run: (c) => taskOutcome(c, SERVER_TASK),
  },
  {
    id: 'server-running',
    label: '비서 서버 실행',
    fix: `예약 작업이 있으면 \`Start-ScheduledTask -TaskName '${SERVER_TASK}'\`(3~4분 뒤 연결), 안 붙으면 \`scripts/server-control.ps1 -Action log\`로 기록을 본다`,
    windows: true,
    probe: () => ({ images: ['powershell.exe', 'pwsh.exe'] }),
    run: ({ o, probe }) => {
      if (!probe?.procs) return { status: 'unknown', detail: '프로세스 조회 실패' };
      const window = serverWindow(probe.procs, o.root);
      if (window) return { status: 'ok', procs: [window] };
      // A window started with higher rights may hide its command line from this session: it could be the server.
      const unreadable = probe.procs.filter((p) => !p.cmd).length;
      if (unreadable) return { status: 'unknown', detail: `명령줄을 못 읽은 PowerShell 창 ${unreadable}개(권한)` };
      return { status: 'missing', detail: 'remote-server.ps1 창이 없음' };
    },
  },
  {
    id: 'backup-task',
    label: '매일 DB 백업 예약 작업',
    fix: '비서 폴더의 PowerShell에서 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-db.ps1 -Install` (매일 03시 이 PC의 `backups/`에, 관리자 권한 필요 없음, README "기억 DB 매일 백업"). 안 쓰면 빼 둔다',
    windows: true,
    probe: () => ({ tasks: [BACKUP_TASK] }),
    run: (c) => taskOutcome(c, BACKUP_TASK),
  },
];


const applies = (c: Check, o: SetupOptions) => (!c.windows || o.platform === 'win32') && (c.applies?.(o) ?? true);

function run(c: Check, ctx: Ctx): Outcome {
  try {
    return c.run(ctx);
  } catch (err) {
    // One odd file must not cost the others (or the hook).
    return { status: 'unknown', detail: String((err as Error).message ?? err).split('\n')[0] };
  }
}

function toResult(c: Check, out: Outcome): CheckResult {
  return {
    id: c.id,
    label: c.label,
    status: out.status,
    ...(out.detail ? { detail: out.detail } : {}),
    ...(out.status === 'missing' ? { fix: c.fix } : {}),
  };
}

const evaluate = (c: Check, ctx: Ctx) => toResult(c, run(c, ctx));

const unique = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

async function safeProbe(o: SetupOptions, q: ProbeQuery): Promise<Probe | null> {
  try {
    return await o.probe(q);
  } catch {
    return null;
  }
}

export async function checkSetup(over: Partial<SetupOptions> = {}, checks: Check[] = CHECKS): Promise<SetupReport> {
  const started = Date.now();
  const o = setupOptions(over);
  const todo = checks.filter((c) => applies(c, o));
  const queries = todo.flatMap((c) => (c.probe ? [c.probe(o)] : []));
  const q: ProbeQuery = { tasks: unique(queries.flatMap((x) => x.tasks ?? [])), images: unique(queries.flatMap((x) => x.images ?? [])) };
  const procChecks = new Set(todo.filter((c) => c.probe?.(o).images?.length).map((c) => c.id));
  const known = q.images.length ? readCache(o.cacheFile)?.procs : undefined;
  let probe = queries.length ? await safeProbe(o, { ...q, ...(known?.length ? { known } : {}) }) : null;
  let outs = todo.map((c) => run(c, { o, probe }));
  // The remembered processes can only confirm: anything short of all ok gets the full list.
  if (probe?.reused && todo.some((c, i) => procChecks.has(c.id) && outs[i].status !== 'ok')) {
    probe = await safeProbe(o, q);
    outs = todo.map((c) => run(c, { o, probe }));
  }
  const procOuts = outs.filter((_, i) => procChecks.has(todo[i].id));
  const allUp = procOuts.length > 0 && procOuts.every((x) => x.status === 'ok');
  const procs = allUp ? [...new Map(procOuts.flatMap((x) => x.procs ?? []).map((p) => [p.pid, p])).values()] : [];
  return {
    checkedAt: new Date().toISOString(),
    ms: Date.now() - started,
    results: todo.map((c, i) => toResult(c, outs[i])),
    ...(procs.length ? { procs } : {}),
  };
}

// ---- Windows probe -------------------------------------------------------------------------

export interface Ran {
  /** Exit code; a string for a spawn error (ENOENT), null when it ran out of time. */
  code: number | string | null;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({ code: e ? (e.killed ? null : (e.code ?? null)) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
    }
  });
}

/** A task name no install registers: what schtasks says for it is its plain "no such task" message. */
const NO_SUCH_TASK = 'Secretary Setup Check No Such Task';
let notFoundMessage: Promise<string | null> | undefined;

/**
 * schtasks exits 0 for a registered task. Exit 1 is "no such task" but also "access denied", so it
 * counts as missing only when the message is the one a surely-absent task gets (in any language);
 * anything else is a failed query.
 */
export function taskAnswer(run: Ran, notFound: string | null): boolean | null {
  if (run.code === 0) return true;
  if (run.code !== 1 || notFound === null) return null;
  return run.stderr.trim() === notFound ? false : null;
}

async function taskRegistered(name: string): Promise<boolean | null> {
  const run = await exec('schtasks.exe', ['/query', '/tn', name]);
  if (run.code !== 1) return taskAnswer(run, null);
  notFoundMessage ??= exec('schtasks.exe', ['/query', '/tn', NO_SUCH_TASK]).then((r) => (r.code === 1 ? r.stderr.trim() : null));
  return taskAnswer(run, await notFoundMessage);
}

const stripBom = (s: string) => s.replace(/^\uFEFF/, '');

/** Turns PowerShell's JSON (one object or an array) into processes; null if it isn't that. */
export function parseProcs(stdout: string): Proc[] | null {
  try {
    const v = JSON.parse(stripBom(stdout).trim() || '[]') as unknown;
    const list = (Array.isArray(v) ? v : [v]) as Array<Record<string, unknown>>;
    return list.map((p) => ({
      pid: Number(p.pid),
      name: String(p.name ?? ''),
      exe: typeof p.exe === 'string' ? p.exe : null,
      cmd: typeof p.cmd === 'string' ? p.cmd : null,
    }));
  } catch {
    return null;
  }
}

/** One PowerShell for all processes. [wmisearcher] skips loading the CIM module (~0.5 s less than Get-CimInstance). */
async function listProcs(images: string[]): Promise<Proc[] | null> {
  if (!images.length) return [];
  const where = images.map((n) => `Name='${n.replace(/['"]/g, '')}'`).join(' OR ');
  const script = [
    // Paths may hold Korean: UTF-8 out, no BOM.
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
    `$p = @(([wmisearcher]"SELECT ProcessId,Name,ExecutablePath,CommandLine FROM Win32_Process WHERE ${where}").Get() | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine } })`,
    'ConvertTo-Json -InputObject $p -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { code, stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  return code === 0 ? parseProcs(stdout) : null;
}

/** The image name tasklist's CSV ("image","pid",…) gives this pid; '' when it lists none (a localized "no tasks" line). */
export function tasklistImage(stdout: string, pid: number): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m && Number(m[2]) === pid) return m[1].toLowerCase();
  }
  return '';
}

/** One tasklist per pid, in parallel (~0.15 s each; listing every process takes ~0.4 s). */
async function imageOf(pid: number): Promise<string | null> {
  const { code, stdout } = await exec('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`]);
  return code === 0 ? tasklistImage(stdout, pid) : null;
}

/** The known processes, if every one still runs under the same image name; else null. */
export async function confirmKnown(known: Proc[], image: (pid: number) => Promise<string | null> = imageOf): Promise<Proc[] | null> {
  const images = await Promise.all(known.map((p) => image(p.pid)));
  return known.every((p, i) => p.name && images[i] === p.name.toLowerCase()) ? known : null;
}

export async function probeWindows(q: ProbeQuery): Promise<Probe> {
  const procs = async (): Promise<{ procs: Proc[] | null; reused?: boolean }> => {
    const confirmed = q.known?.length ? await confirmKnown(q.known) : null;
    return confirmed ? { procs: confirmed, reused: true } : { procs: await listProcs(q.images) };
  };
  const [p, ...registered] = await Promise.all([procs(), ...q.tasks.map(taskRegistered)]);
  return { tasks: Object.fromEntries(q.tasks.map((t, i) => [t, registered[i]])), ...p };
}

// ---- Cache and notices ---------------------------------------------------------------------

export function readCache(file: string): SetupCache | null {
  const c = readJson<SetupCache>(file);
  return c && Array.isArray(c.results) ? { ...c, skip: Array.isArray(c.skip) ? c.skip : [] } : null;
}

/** Keeps the user's skip list across checks. Best effort: a failed write only costs the reminders. */
export function saveReport(report: SetupReport, file: string): SetupCache {
  const cache = { ...report, skip: readCache(file)?.skip ?? [] };
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 1));
  } catch {}
  return cache;
}

/** Adds (or with remove, takes out; 'all' clears) items the user chose to go without. */
export function setSkip(file: string, ids: string[], remove = false): string[] {
  const cache = readCache(file) ?? { checkedAt: '', ms: 0, results: [], skip: [] };
  const skip = remove ? (ids.includes('all') ? [] : cache.skip.filter((s) => !ids.includes(s))) : [...new Set([...cache.skip, ...ids])];
  fs.writeFileSync(file, JSON.stringify({ ...cache, skip }, null, 1));
  return skip;
}

const pending = (results: CheckResult[], skip: string[], status: Status) => results.filter((r) => r.status === status && !skip.includes(r.id));

export function openingLine(missing: CheckResult[]): string {
  return `'아직 설치가 덜 됐어요: ${missing.map((r) => r.label).join(', ')}. "설치 이어서 해 줘"라고 하시면 도와드릴게요'`;
}

/** The session-start notice: '' unless something is missing (unknown items alone stay quiet). */
export function setupNotice(results: CheckResult[], skip: string[] = []): string {
  const missing = pending(results, skip, 'missing');
  if (!missing.length) return '';
  const unknown = pending(results, skip, 'unknown');
  return [
    '<secretary-setup>비서 설치가 덜 끝났어요(세션 시작 점검). 빠진 항목:',
    ...missing.map((r) => `- [${r.id}] ${r.label}${r.detail ? ` (${r.detail})` : ''} → ${r.fix}`),
    ...(unknown.length ? [`확인 못 함: ${unknown.map((r) => `${r.label}${r.detail ? `(${r.detail})` : ''}`).join(', ')}`] : []),
    `비서 할 일: 매 답 맨 위에 한 줄로 ${openingLine(missing)}를 붙인다. 사용자가 원하면 위 방법과 README의 해당 단계를 함께 진행하고(관리자 PowerShell이 필요한 것은 사용자에게 실행을 부탁), 마치면 \`node src/cli.ts setup-check\`로 다시 확인한다. 모두 갖춰지면 알림이 멈춘다. 사용자가 어떤 항목은 쓰지 않겠다고 하면 \`node src/cli.ts setup-check --skip <id>\`로 빼 둔다.`,
    '</secretary-setup>',
  ].join('\n');
}

/** Session start: full check, kept for the prompt hook. Never rejects. */
export async function sessionSetup(over: Partial<SetupOptions> = {}): Promise<{ notice: string; report: SetupReport | null }> {
  if (disabled()) return { notice: '', report: null };
  try {
    const o = setupOptions(over);
    const report = await checkSetup(o);
    const cache = saveReport(report, o.cacheFile);
    return { notice: setupNotice(report.results, cache.skip), report };
  } catch (err) {
    process.stderr.write(`[secretary] setup check failed: ${(err as Error).message}\n`);
    return { notice: '', report: null };
  }
}

/**
 * Prompt hook: one line while something is still missing, '' otherwise (and with no check kept yet).
 * Files are looked at again (milliseconds); tasks and processes keep the last full check.
 */
export function setupReminder(over: Partial<SetupOptions> = {}): string {
  if (disabled()) return '';
  try {
    const o = setupOptions(over);
    const cache = readCache(o.cacheFile);
    if (!cache) return '';
    // File items are looked at again; one that no longer applies (semantic search turned off) drops out.
    const live = new Map(CHECKS.filter((c) => !c.probe).map((c) => [c.id, applies(c, o) ? evaluate(c, { o, probe: null }) : null] as const));
    const results = cache.results.flatMap((r) => {
      const now = live.get(r.id);
      return now === undefined ? [r] : now ? [now] : [];
    });
    const missing = pending(results, cache.skip, 'missing');
    if (!missing.length) return '';
    return `<secretary-setup>이 답 맨 위 한 줄로 ${openingLine(missing)}를 붙인다. 방법은 \`node src/cli.ts setup-check\` 출력과 README.</secretary-setup>`;
  } catch {
    return '';
  }
}

/** For `node src/cli.ts setup-check`: one line per item, then what to do about the missing ones. */
export function formatReport(report: SetupReport, skip: string[]): string {
  const mark: Record<Status, string> = { ok: '✓', missing: '✗', unknown: '?' };
  const lines = report.results.map((r) => {
    const skipped = skip.includes(r.id) ? ' (뺌)' : '';
    return `${mark[r.status]} [${r.id}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}${skipped}`;
  });
  const todo = pending(report.results, skip, 'missing').map((r) => `- [${r.id}] ${r.fix}`);
  return [...lines, `(${report.ms}ms)`, ...(todo.length ? ['', '할 일:', ...todo] : ['', '빠진 항목 없음'])].join('\n');
}
