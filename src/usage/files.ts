/**
 * Where subscription usage is kept, one file per Claude account: ~/.claude/usage/subscription-<account>.json
 * (e.g. subscription-hong.json, subscription-kim2.json). The account is the provider's login (its .claude.json,
 * core/provider-accounts.ts) before the @, and only the account names the file: whatever the provider is called
 * (subscription, subscription-b or another name), the same login is the same file, and two secretaries on one PC that
 * log in as different accounts never read or write each other's usage. A provider with no login (another company's CLI,
 * an API key) or one whose login can't be read keeps its plain name (antigravity.json). Its "keep going past 90%" lift
 * (guard-override-<same>.json), the refresh mark (<same>.refresh) and the failed readings (<same>.fail) go by the same name.
 * Shared by the prompt hook (usage/guard-override.ts, usage/handoff-level.ts), the dashboard (dashboard/collect.ts), the
 * usage reader (usage/usage-poller.ts) and the plain-JS scripts (scripts/usage/usage-file.mjs re-exports this for the
 * status line and the usage guard). scripts/usage/usage-query.ps1 and run-job-other.ps1 name the files by the same rule
 * (Get-UsageKey in scripts/lib/providers.ps1).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../core/json-file.ts';
import { USAGE_DIR } from '../core/paths.ts';
import { providerAccount, type AccountDeps } from '../core/provider-accounts.ts';
import { labeler, readProviders } from './providers.ts';

export { USAGE_DIR };

/**
 * The lift before it went by account: one file that lifted the guard for every account and every secretary on this PC.
 * Nothing reads it any more; the next lift deletes it (applyGuardOverride).
 */
export const LEGACY_OVERRIDE_FILE = join(USAGE_DIR, 'guard-override.json');

/** The provider this process runs on; providers.ps1 Use-Provider and the b server pass it as SECRETARY_PROVIDER. */
export function currentProvider(env: NodeJS.ProcessEnv = process.env): string {
  return env.SECRETARY_PROVIDER || 'subscription';
}

/**
 * Whether this process runs Claude Code on a subscription login, the only kind the usage guard stops
 * (scripts/usage/usage-guard.mjs): Bedrock, Vertex, an API key or a gateway token pays per use and has no 5-hour window.
 */
export function onSubscription(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CLAUDE_CODE_USE_BEDROCK && !env.CLAUDE_CODE_USE_VERTEX && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN;
}

/** Letters, digits and _ . - only (ASCII), the rest as _ (providers.ps1 Get-UsageKey: the same class). */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** What a usage file name starts with when an account names it (providers.ps1 Get-UsageKey: the same). */
const ACCOUNT_PREFIX = 'subscription-';

/**
 * The name of a provider's usage files: "subscription-<account>" for a Claude subscription whose login can be read (the
 * provider's own name is not in it), else the provider's name.
 */
export function usageKey(provider = currentProvider(), d: AccountDeps = {}): string {
  const account = providerAccount(provider, d);
  return account ? ACCOUNT_PREFIX + safeName(account) : safeName(provider);
}

export function usageFile(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): string {
  return join(dir, `${usageKey(provider, d)}.json`);
}

/** When someone last started reading the provider's usage (ms): the usage guard and the usage reader leave it. */
export function refreshFile(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): string {
  return join(dir, `${usageKey(provider, d)}.refresh`);
}

/**
 * The last readings that failed in a row ({ at, count, reason }): usage-query.ps1 writes it when /usage gives no usage
 * (an API key login, a provider with no such command, no claude), and deletes it when a reading works; the usage reader
 * writes it when the script failed before it could. The usage guard and the usage reader then wait failureWaitMs before
 * the next try instead of starting one every 5 minutes for ever.
 */
export function failFile(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): string {
  return join(dir, `${usageKey(provider, d)}.fail`);
}

export interface UsageFailure {
  at: string;
  count: number;
  reason?: string;
}

/** The wait after `count` failures in a row: 5 minutes, doubling, at most 6 hours. */
export function failureWaitMs(count: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, count - 1), 6 * 3600_000);
}

export function readFailure(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): UsageFailure | null {
  const j = readJsonFile<UsageFailure>(failFile(provider, dir, d));
  return j && typeof j.at === 'string' && Number.isFinite(Date.parse(j.at)) ? { ...j, count: Math.max(1, Number(j.count) || 1) } : null;
}

/** How long until the provider's next reading may start (ms; 0: now): failures in a row put it off (failureWaitMs). */
export function failureWait(provider = currentProvider(), dir = USAGE_DIR, now = Date.now(), d: AccountDeps = {}): number {
  const f = readFailure(provider, dir, d);
  return f ? Math.max(0, Date.parse(f.at) + failureWaitMs(f.count) - now) : 0;
}

/** One more failure in a row (usage-query.ps1 Save-UsageFailure writes the same shape). */
export function recordFailure(provider: string, reason: string, dir = USAGE_DIR, now = Date.now(), d: AccountDeps = {}): UsageFailure {
  const f: UsageFailure = { at: new Date(now).toISOString(), count: (readFailure(provider, dir, d)?.count ?? 0) + 1, reason: reason.slice(0, 200) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(failFile(provider, dir, d), JSON.stringify(f));
  return f;
}

/** "Keep going past 90%": the usage guard is lifted for this provider's account until the `until` time in this file. */
export function overrideFile(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): string {
  return join(dir, `guard-override-${usageKey(provider, d)}.json`);
}

/**
 * The names a provider's files had before, given its name now (`key`, usageKey): "<provider>" (before names had the
 * account) and "<provider>-<account>" (before only the account named them, e.g. subscription-b-kim2). Nothing when the
 * key is still the provider's plain name (no account to go by). providers.ps1 Get-LegacyUsageKeys: the same.
 */
export function legacyUsageKeys(provider: string, key: string): string[] {
  const plain = safeName(provider);
  if (key === plain || !key.startsWith(ACCOUNT_PREFIX)) return [];
  const withProvider = `${plain}-${key.slice(ACCOUNT_PREFIX.length)}`;
  return [...new Set([plain, withProvider])].filter((k) => k.toLowerCase() !== key.toLowerCase());
}

/**
 * After a provider's usage was written under its account name: its files under the old names (legacyUsageKeys) go, so
 * nothing reads another account's numbers from the plain one or keeps a stale copy under the provider-and-account one.
 * A name that is some provider's name now (usageKey of each in providers.json) is never removed: an account called "b"
 * makes subscription's file subscription-b.json, the old plain name of provider subscription-b. A "keep going past 90%"
 * lift under the old provider-and-account name moves to the new name (same account) unless one is there; under the plain
 * name it goes. Called by the status line right after it writes; usage-query.ps1 does the same (Remove-LegacyUsageFiles).
 * Returns what it removed or moved.
 */
export function dropLegacyUsageFiles(provider = currentProvider(), dir = USAGE_DIR, d: AccountDeps = {}): string[] {
  const key = usageKey(provider, d);
  const old = legacyUsageKeys(provider, key);
  const files = (k: string) => [join(dir, `${k}.json`), join(dir, `${k}.refresh`), join(dir, `guard-override-${k}.json`)];
  // The status line calls this on every write: once the old files are gone, no login files are read.
  if (!old.some((k) => files(k).some((f) => fs.existsSync(f)))) return [];
  // Compared without case: Windows file names don't tell subscription-B from subscription-b. Each provider's name now as its
  // own clean environment gives it (clean: this process's CLAUDE_CONFIG_DIR is not another provider's login), the way
  // usage-query.ps1 reads it (Remove-LegacyUsageFiles uses Get-UsageKey -Clean).
  const current = new Set(readProviders(d.root).map((p) => usageKey(p.name, { ...d, clean: true }).toLowerCase()));
  const plain = safeName(provider);
  const lift = join(dir, `guard-override-${key}.json`);
  const gone: string[] = [];
  const drop = (file: string, moveTo?: string) => {
    if (!fs.existsSync(file)) return;
    try {
      if (moveTo && !fs.existsSync(moveTo)) fs.renameSync(file, moveTo);
      else fs.rmSync(file, { force: true });
      gone.push(file);
    } catch {}
  };
  for (const name of old.filter((k) => !current.has(k.toLowerCase()))) {
    const [usage, refresh, oldLift] = files(name);
    drop(usage);
    drop(refresh);
    drop(oldLift, name === plain ? undefined : lift);
  }
  return gone;
}

export interface UsageState {
  five_hour_pct: number;
  resets_at?: string;
  updated_at: string;
}

export function readUsage(provider: string, dir = USAGE_DIR, d: AccountDeps = {}): UsageState | null {
  return readJsonFile<UsageState>(usageFile(provider, dir, d));
}

/** Provider this session runs on; the b server (remote-server.ps1 -Provider) passes it down as SECRETARY_PROVIDER. */
export function chatProvider(env = process.env): string {
  return currentProvider(env);
}

/** The provider's display name (usage/providers.ts: its label in providers.json, else 계정 a / 계정 b / its name). */
export function accountLabel(provider: string): string {
  return labeler(readProviders())(provider);
}
