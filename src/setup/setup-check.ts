/**
 * Install check: is everything the README installs actually in place on this PC?
 *
 * The session-start hook runs the full check and, only when something is missing, injects a
 * <secretary-setup> notice with what is missing, how to fix it and what the secretary does about
 * it. A complete install injects nothing. The rule rides along with the notice, so it costs
 * nothing in AGENTS.md (same idea as <secretary-semantic-search-server>).
 *
 * Files are looked at directly (milliseconds). Scheduled tasks and processes need Windows:
 * one schtasks.exe per task (~60 ms, in parallel) and one PowerShell WMI query for the processes
 * (~1.7-2.2 s on one PC, nearly all PowerShell's own start-up), started before the hook's
 * other work so they overlap. When the last check found the server window, its pid
 * is kept and only confirmed (tasklist per pid, ~0.2 s); anything short of that gets the full
 * query. A query that fails or runs out of time leaves its items "unknown", which never fails the
 * hook and never raises the notice on its own. So does an answer that may only mean "not allowed":
 * a process whose command line could not be read (a window started with higher rights), or a
 * schtasks failure that is not its plain "no such task" message (exit 1 is also "access denied").
 * A registered task whose file (the script after -File) is gone counts as missing: it would fail
 * every time it runs.
 *
 * The full result is kept next to the database. The prompt hook re-reads it, looks at the files
 * again (a mid-session `npm install` counts at once) and, while something is still missing, adds
 * a one-line reminder: the secretary is to open every answer with it. Tasks and processes keep
 * the session-start answer until `node src/cli.ts setup-check` checks again.
 *
 * The items are in setup/check-items.ts, the Windows queries in setup/windows-probe.ts. Items of a feature turned off
 * in features.json are not checked, and those of an original-only feature are marked "원본 전용" (core/features.ts).
 */
import fs from 'node:fs';
import { DB_PATH, PROJECT_ROOT } from '../core/config.ts';
import { originalOnlyChecks } from '../core/features.ts';
import { accountConfigDirs, keysDir } from '../core/provider-accounts.ts';
import { MODEL_PATH } from '../semantic-search/client.ts';
import { activeChecks, CHECKS } from './check-items.ts';
import { probeWindows } from './windows-probe.ts';
import { readJsonFile } from '../core/json-file.ts';
import { ensureSecretaryId } from '../core/secretary-id.ts';
import { CHECK, CLI, TAG } from '../core/names.ts';

export { activeChecks, CHECKS, LOADED_MODEL_FILES, serverWindow, taskNamesFor, usageHookProblems } from './check-items.ts';
export { confirmKnown, parseProcs, probeWindows, regValue, taskAnswer, tasklistImage, taskTargetFile, type Ran } from './windows-probe.ts';


export type Status = 'ok' | 'missing' | 'unknown';
export type Scope = 'common' | 'original';

export interface CheckResult {
  id: string;
  scope: Scope;
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
  /** The user's own environment variables to read (as registered, not this process's copy). */
  env?: string[];
  /**
   * The processes the last check found everything running on. If each pid still runs under the
   * same image name (tasklist, ~0.1 s), they stand in for the PowerShell list (~1.7 s).
   */
  known?: Proc[];
}

export interface Probe {
  /** Registered or not; null when the query failed. */
  tasks: Record<string, boolean | null>;
  /** The file each registered task runs (bin/<entry>, …); null or absent when it can't tell. */
  taskFiles?: Record<string, string | null>;
  /** null when the process query failed or ran out of time. */
  procs: Proc[] | null;
  /** procs are the known ones, confirmed alive, not a fresh list. */
  reused?: boolean;
  /** Each asked-for user variable: its value, '' when not set, null when the query failed. */
  env?: Record<string, string | null>;
}

export interface SetupOptions {
  root: string;
  dbPath: string;
  modelPath: string;
  keysDir: string;
  platform: NodeJS.Platform;
  /** Whether the database was there before this process opened it (openDb creates a missing one). */
  dbExisted?: boolean;
  probe: (q: ProbeQuery) => Promise<Probe>;
  cacheFile: string;
  /** Claude config folders whose settings.json should carry the usage hook and status line (every account's). */
  configDirs: string[];
  /** `tailscale status --json` output (tests); default runs tailscale (core/tailscale.ts, never under the test mark). */
  tailscaleStatus?: () => string | null;
}

export function setupOptions(over: Partial<SetupOptions> = {}): SetupOptions {
  const dbPath = over.dbPath ?? DB_PATH;
  return {
    root: PROJECT_ROOT,
    modelPath: MODEL_PATH,
    keysDir: keysDir(),
    configDirs: over.configDirs ?? accountConfigDirs(over.root ?? PROJECT_ROOT),
    platform: process.platform,
    probe: probeWindows,
    cacheFile: `${dbPath}.setup-check.json`,
    ...over,
    dbPath,
  };
}

const disabled = () => process.env.SECRETARY_SETUP_CHECK === 'off';

export interface Outcome {
  status: Status;
  detail?: string;
  /** How to fix it when this outcome needs other steps than the item's own fix (another secretary's setting, …). */
  fix?: string;
  /** The processes an ok rests on. */
  procs?: Proc[];
}

export interface Ctx {
  o: SetupOptions;
  probe: Probe | null;
}

export interface Check {
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


const applies = (c: Check, o: SetupOptions) => (!c.windows || o.platform === 'win32') && (c.applies?.(o) ?? true);

function run(c: Check, ctx: Ctx): Outcome {
  try {
    return c.run(ctx);
  } catch (err) {
    // One odd file must not cost the others (or the hook).
    return { status: 'unknown', detail: String((err as Error).message ?? err).split('\n')[0] };
  }
}

/** Each item's scope, from its feature in features.json. */
const scopes = (o: SetupOptions) => {
  const original = originalOnlyChecks(o.root);
  return (c: Check): Scope => (original.has(c.id) ? 'original' : 'common');
};

function toResult(c: Check, out: Outcome, scope: Scope): CheckResult {
  return {
    id: c.id,
    scope,
    label: c.label,
    status: out.status,
    ...(out.detail ? { detail: out.detail } : {}),
    ...(out.status === 'missing' ? { fix: out.fix ?? c.fix } : {}),
  };
}


const unique = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

async function safeProbe(o: SetupOptions, q: ProbeQuery): Promise<Probe | null> {
  try {
    return await o.probe(q);
  } catch {
    return null;
  }
}

/** checks: all items whose feature is on (features.json under o.root) unless given. */
export async function checkSetup(over: Partial<SetupOptions> = {}, checks?: Check[]): Promise<SetupReport> {
  const started = Date.now();
  const o = setupOptions(over);
  // A first install (or a copy updated from a version before it) gets its secretary id here: task names carry it.
  ensureSecretaryId(o.root);
  const scopeOf = scopes(o);
  const todo = (checks ?? activeChecks(o.root)).filter((c) => applies(c, o));
  const queries = todo.flatMap((c) => (c.probe ? [c.probe(o)] : []));
  const env = unique(queries.flatMap((x) => x.env ?? []));
  const q: ProbeQuery = {
    tasks: unique(queries.flatMap((x) => x.tasks ?? [])),
    images: unique(queries.flatMap((x) => x.images ?? [])),
    ...(env.length ? { env } : {}),
  };
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
    results: todo.map((c, i) => toResult(c, outs[i], scopeOf(c))),
    ...(procs.length ? { procs } : {}),
  };
}

// ---- Cache and notices ---------------------------------------------------------------------

/**
 * Item ids renamed 2026-11-09 and 2026-11-10 (old → new). A skip list written before still names the old ones: read as the new ids
 * for a while (the list is written back with the new ones the next time it changes).
 */
export const OLD_CHECK_IDS: Readonly<Record<string, string>> = { // legacy-name: setup-check-ids
  model: CHECK.semanticSearchModel,
  packages: CHECK.npmPackages,
  'secretary-dir': CHECK.secretaryDirEnv,
  notify: CHECK.phonePush,
  'workspace-folders': CHECK.workspaceAuxFolders,
};

export function readCache(file: string): SetupCache | null {
  const c = readJsonFile<SetupCache>(file);
  if (!c || !Array.isArray(c.results)) return null;
  const skip = Array.isArray(c.skip) ? [...new Set(c.skip.map((s) => OLD_CHECK_IDS[s] ?? s))] : [];
  return { ...c, skip };
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
    `<${TAG.setup}>비서 설치가 덜 끝났어요(세션 시작 점검). 빠진 항목:`,
    ...missing.map((r) => `- [${r.id}] ${r.label}${r.detail ? ` (${r.detail})` : ''} → ${r.fix}`),
    ...(unknown.length ? [`확인 못 함: ${unknown.map((r) => `${r.label}${r.detail ? `(${r.detail})` : ''}`).join(', ')}`] : []),
    `비서 할 일: 매 답 맨 위에 한 줄로 ${openingLine(missing)}를 붙인다. 사용자가 원하면 위 방법과 README의 해당 단계를 함께 진행하고(관리자 PowerShell이 필요한 것은 사용자에게 실행을 부탁), 마치면 \`node src/cli.ts ${CLI.setupCheck}\`로 다시 확인한다. 모두 갖춰지면 알림이 멈춘다. 사용자가 어떤 항목은 쓰지 않겠다고 하면 \`node src/cli.ts ${CLI.setupCheck} --skip <id>\`로 빼 둔다.`,
    `</${TAG.setup}>`,
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
    // File items are looked at again; one that no longer applies (semantic search turned off, its feature
    // turned off in features.json) drops out.
    const on = new Set(activeChecks(o.root).map((c) => c.id));
    const scopeOf = scopes(o);
    const live = new Map(
      CHECKS.filter((c) => !c.probe || !on.has(c.id)).map((c) => [c.id, on.has(c.id) && applies(c, o) ? toResult(c, run(c, { o, probe: null }), scopeOf(c)) : null] as const),
    );
    const results = cache.results.flatMap((r) => {
      const now = live.get(r.id);
      return now === undefined ? [r] : now ? [now] : [];
    });
    const missing = pending(results, cache.skip, 'missing');
    if (!missing.length) return '';
    return `<${TAG.setup}>이 답 맨 위 한 줄로 ${openingLine(missing)}를 붙인다. 방법은 \`node src/cli.ts ${CLI.setupCheck}\` 출력과 README.</${TAG.setup}>`;
  } catch {
    return '';
  }
}

/**
 * For `node src/cli.ts setup-check`: one line per item, then what to do about the missing ones, then
 * (off: offFeatureChecks) one line naming the features turned off whose items were left out and how to
 * turn them on. Only this direct run says so; the session-start notice (setupNotice) does not.
 */
export function formatReport(report: SetupReport, skip: string[], off: { id: string; checks: string[] }[] = []): string {
  const mark: Record<Status, string> = { ok: '✓', missing: '✗', unknown: '?' };
  const lines = report.results.map((r) => {
    const skipped = skip.includes(r.id) ? ' (뺌)' : '';
    return `${mark[r.status]} [${r.id}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}${skipped}${r.scope === 'original' ? '  · 원본 전용' : ''}`;
  });
  const todo = pending(report.results, skip, 'missing').map((r) => `- [${r.id}] ${r.fix}`);
  const offLine = off.length
    ? [`꺼진 기능: ${off.map((f) => `${f.id}(점검 안 한 항목: ${f.checks.join(', ')})`).join(', ')} (켜려면 features.json에서 enabled를 true로)`]
    : [];
  return [...lines, `(${report.ms}ms)`, ...(todo.length ? ['', '할 일:', ...todo] : ['', '빠진 항목 없음']), ...offLine].join('\n');
}
