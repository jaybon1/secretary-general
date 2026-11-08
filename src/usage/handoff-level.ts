/**
 * Several subscriptions (feature account-handoff, "다중 구독"): the prompt hook's line (notice 'usage') telling the secretary
 * how much to hand off and to which account, and the account `auto` resolves to for run-job and work sessions
 * (`node src/cli.ts handoff-account`, called by Use-Provider in scripts/lib/providers.ps1).
 * Account a ('subscription') is the chat account. Every other "claude-subscription" in scripts/lib/providers.json (b, c, …)
 * is one work can be handed to; the one with the most room is picked (pickHandoff). With one such account (a and b only)
 * everything is as it was before there could be more: b is always the one, and the line reads the same.
 * Usage files (usage/files.ts, one per login account) are written by the status line and scripts/usage/usage-query.ps1.
 */
import { readJsonFile } from '../core/json-file.ts';
import { scriptPath } from '../core/paths.ts';
import { PROJECT_ROOT } from '../core/config.ts';
import type { AccountDeps } from '../core/provider-accounts.ts';
import { chatProvider, readUsage, USAGE_DIR, type UsageState } from './files.ts';
import { providerLabel, readProviders, type ProviderInfo } from './providers.ts';

/** Account a's 5-hour % at which each handoff level starts (level 1 below the first). */
export const LEVEL_STARTS = [20, 40, 60];

/** The chat account: never handed to (it is the one being spared). */
export const CHAT_ACCOUNT = 'subscription';

/** The provider name that means "pick the account with the most room" (providers.json default, or -Provider auto). */
export const AUTO_PROVIDER = 'auto';

export function handoffLevel(pct: number): number {
  return 1 + LEVEL_STARTS.filter((start) => pct >= start).length;
}

/**
 * While the account handed to (b, or the one picked) has used less than twice account a's %, hand off even small jobs;
 * otherwise go by a's level. `id` names it in the note ("b 우선").
 */
export function handoffNote(aPct: number, bPct: number, id = 'b'): string {
  return bPct < 2 * aPct ? `${id} 우선(작은 일도 넘김)` : `넘기기 ${handoffLevel(aPct)}단계`;
}

/** The usage guard's limit (scripts/usage/usage-guard.mjs reads the same variable): an account at it is not picked. */
export function pauseLimit(env = process.env): number {
  const n = Number(env.USAGE_PAUSE_PCT ?? 90);
  return Number.isFinite(n) ? n : 90;
}

/** The usage file's fields this reads (usage-query.ps1 writes the week ones; the status line may leave them out). */
type Usage = UsageState & { week_pct?: number | null; week_resets_at?: string | null };

const isReset = (resetsAt: string | null | undefined, now: number) => !!resetsAt && now >= Date.parse(resetsAt);

function currentPct(s: Usage | null, now: number): number {
  if (!s || isReset(s.resets_at, now)) return 0;
  return s.five_hour_pct;
}

/** At the guard's limit in its 5 hours or its week (not yet reset): the guard would stop work there at once. */
function isFull(s: Usage | null, now: number, limit: number): boolean {
  if (!s) return false;
  return currentPct(s, now) >= limit || (!isReset(s.week_resets_at, now) && (s.week_pct ?? 0) >= limit);
}

function describe(name: string, s: Usage | null, now: number): string {
  if (!s) return `${name} 기록 없음`;
  if (isReset(s.resets_at, now)) return `${name} 초기화됨`;
  const age = Math.round((now - Date.parse(s.updated_at)) / 60000);
  return `${name} ${Math.round(s.five_hour_pct)}%${age > 10 ? `(${age}분 전 기록)` : ''}`;
}

/** The short name in a note: "b" for 계정 b, else the label itself. */
const shortId = (label: string) => /^계정\s*(\S+)$/.exec(label)?.[1] ?? label;

/**
 * The accounts work can be handed to: every Claude subscription in providers.json but account a, in the file's order.
 * None listed (or the file unreadable): b by its usual name, as before more than one was possible.
 */
export function handoffTargets(list: ProviderInfo[]): ProviderInfo[] {
  const targets = list.filter((p) => p.type === 'claude-subscription' && p.name !== CHAT_ACCOUNT);
  return targets.length ? targets : [{ name: 'subscription-b', type: 'claude-subscription', label: providerLabel('subscription-b'), usage: 'claude-usage' }];
}

export interface AccountUsage {
  provider: string;
  label: string;
  usage: Usage | null;
}

/**
 * The account to hand work to, among `accounts` (handoffTargets with their usage): the lowest 5-hour % among those not at
 * the guard's limit (5 hours or week) that have a reading; an account with no reading yet only when none has one (it may
 * not be logged in); ties to `prefer` (providers.json default), then the file's order. When every one is at the limit, the
 * lowest of them anyway (the line says so; the delegate skill asks before going elsewhere). null only for an empty list.
 */
export function pickHandoff(accounts: AccountUsage[], now = Date.now(), limit = pauseLimit(), prefer?: string): AccountUsage | null {
  const rank = (a: AccountUsage, i: number) => [isFull(a.usage, now, limit) ? 1 : 0, a.usage ? 0 : 1, currentPct(a.usage, now), a.provider === prefer ? 0 : 1, i];
  const ranked = accounts.map((a, i) => ({ a, r: rank(a, i) }));
  ranked.sort((x, y) => {
    for (let k = 0; k < x.r.length; k++) if (x.r[k] !== y.r[k]) return x.r[k] - y.r[k];
    return 0;
  });
  return ranked[0]?.a ?? null;
}

export interface HandoffDeps {
  /** Where the usage files are (~/.claude/usage). */
  dir?: string;
  /** How each provider's login account is found (its usage file's name). */
  account?: AccountDeps;
  /** providers.json as read; else read from account.root. */
  providers?: ProviderInfo[];
  /** providers.json's default; else read from account.root. */
  defaultProvider?: string;
  limit?: number;
}

function readDefault(root = PROJECT_ROOT): string | undefined {
  const d = readJsonFile<{ default?: unknown }>(scriptPath('providers', root))?.default;
  return typeof d === 'string' ? d : undefined;
}

function load(deps: HandoffDeps) {
  const dir = deps.dir ?? USAGE_DIR;
  const list = deps.providers ?? readProviders(deps.account?.root);
  const def = deps.defaultProvider ?? readDefault(deps.account?.root);
  const read = (p: { name: string; label: string }): AccountUsage => ({ provider: p.name, label: p.label, usage: readUsage(p.name, dir, deps.account) as Usage | null });
  const label = list.find((p) => p.name === CHAT_ACCOUNT)?.label ?? providerLabel(CHAT_ACCOUNT);
  return { list, def, a: read({ name: CHAT_ACCOUNT, label }), targets: handoffTargets(list).map(read) };
}

/**
 * The provider `auto` resolves to: this session's own account when it chats on one of the accounts handed to (a b server:
 * work stays on b, as the line says), else the one pickHandoff picks, else account a when there is no other subscription.
 */
export function handoffAccount(now = Date.now(), provider = chatProvider(), deps: HandoffDeps = {}): string {
  const { list, def, targets } = load(deps);
  if (!list.some((p) => p.type === 'claude-subscription' && p.name !== CHAT_ACCOUNT)) return CHAT_ACCOUNT;
  if (targets.some((t) => t.provider === provider)) return provider;
  return pickHandoff(targets, now, deps.limit ?? pauseLimit(), def)?.provider ?? CHAT_ACCOUNT;
}

export function usageContext(now = Date.now(), provider = chatProvider(), deps: HandoffDeps = {}): string {
  const { def, a, targets } = load(deps);
  const limit = deps.limit ?? pauseLimit();
  // Chatting on an account handed to (a ran out): no cheaper account to hand off to, so work sessions and run-job stay on it
  // and its % sets the level.
  const self = targets.find((t) => t.provider === provider);
  if (self) {
    if (!self.usage) return '';
    const id = shortId(self.label);
    const others = [a, ...targets.filter((t) => t !== self)].map((t) => describe(t.label, t.usage, now)).join(' · ');
    return `<secretary-usage>이 세션은 ${self.label}. 5시간 사용량: ${describe(self.label, self.usage, now)} · ${others} → 넘기기 ${handoffLevel(currentPct(self.usage, now))}단계(${id} 기준, 넘기는 일도 ${id})</secretary-usage>`;
  }
  if (!a.usage) return '';
  const picked = pickHandoff(targets, now, limit, def) ?? targets[0];
  const all = [a, ...targets].map((t) => describe(t.label, t.usage, now)).join(' · ');
  const note = handoffNote(currentPct(a.usage, now), currentPct(picked.usage, now), shortId(picked.label));
  // One account to hand to (a and b): the line as it always was. More: which one was picked, and how to reach it.
  if (targets.length < 2) return `<secretary-usage>5시간 사용량: ${all} → ${note}</secretary-usage>`;
  const full = targets.every((t) => isFull(t.usage, now, limit)) ? `(넘길 구독 모두 ${limit}% 이상)` : '';
  const how = def === AUTO_PROVIDER || def === picked.provider ? '' : ` (run-job·업무 세션은 기본 공급자 ${def ?? '(없음)'}로 도니 -Provider ${picked.provider}를 준다)`;
  return `<secretary-usage>5시간 사용량: ${all} → ${picked.label}에 넘김${full}, ${note}${how}</secretary-usage>`;
}
