/**
 * Providers as the usage side sees them (scripts/lib/providers.json): each one's display name and how its usage is
 * read. A provider says it in one field, so a new one needs only that:
 *   "usage": "claude-usage"   a Claude subscription: `claude -p "/usage"` (no model call, no tokens)
 *   "usage": "agy"            Antigravity CLI: `agy -p=/usage` (no tokens)
 *   "usage": "none" or none   no way to read it (shown as 조회 안 됨)
 *   "label": "…"              optional display name; without it subscription is 계정 a, subscription-b 계정 b (any
 *                             subscription-<one or two letters/digits>: 계정 <them>, e.g. subscription-c 계정 c), else the name
 * scripts/usage/usage-query.ps1 does the reading and writes ~/.claude/usage/subscription-<account>.json (usage/files.ts); the dashboard (feature
 * 'dashboard') runs it for the providers checked in its settings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readJsonFile } from '../core/json-file.ts';
import { keyFileConfigDir, keysDir } from '../core/provider-accounts.ts';
import { scriptPath } from '../core/paths.ts';

export const USAGE_METHODS = ['claude-usage', 'agy'] as const;
export type UsageMethod = (typeof USAGE_METHODS)[number] | 'none';

/** How each method reads, in plain words (the dashboard's settings page). */
export const METHOD_TEXT: Record<UsageMethod, string> = {
  'claude-usage': '구독 /usage (토큰 0)',
  agy: 'Antigravity /usage (토큰 0)',
  none: '조회 안 됨',
};

export interface ProviderInfo {
  name: string;
  type: string;
  label: string;
  usage: UsageMethod;
}

interface RawProvider {
  type?: unknown;
  usage?: unknown;
  label?: unknown;
}

/**
 * The name people see: the provider's label, else 계정 a for subscription and 계정 <id> for subscription-<id> (b, c, b2:
 * a letter, then at most one more letter or digit; the "계정 c 90퍼 넘어도 진행" phrase names it so), else its name.
 */
export function providerLabel(name?: string | null, label?: unknown): string {
  if (typeof label === 'string' && label.trim()) return label.trim();
  if (!name || name === 'subscription') return '계정 a';
  const id = /^subscription-([A-Za-z][A-Za-z0-9]?)$/.exec(name)?.[1];
  return id ? `계정 ${id}` : name;
}

const methodOf = (v: unknown): UsageMethod => ((USAGE_METHODS as readonly unknown[]).includes(v) ? (v as UsageMethod) : 'none');

/** Every provider in providers.json, in its order; an unreadable file is an empty list. */
export function readProviders(root = PROJECT_ROOT, file = scriptPath('providers', root)): ProviderInfo[] {
  const config = readJsonFile<{ providers?: Record<string, RawProvider> }>(file);
  const list = config?.providers && typeof config.providers === 'object' ? config.providers : {};
  return Object.entries(list).map(([name, p]) => ({
    name,
    type: typeof p?.type === 'string' ? p.type : '',
    label: providerLabel(name, p?.label),
    usage: methodOf(p?.usage),
  }));
}

/** A labeler over a list read once: name → display name (a name not in the list gets the fallback). */
export function labeler(list: ProviderInfo[]): (name?: string | null) => string {
  const byName = new Map(list.map((p) => [p.name, p.label]));
  return (name) => byName.get(name || 'subscription') ?? providerLabel(name);
}

export interface ConfiguredDeps {
  keysDir?: string;
  home?: string;
  localAppData?: string;
}

/** The agy program, where its installer puts it (scripts/usage/usage-query.ps1 runs the same path). */
export const agyExe = (localAppData = process.env.LOCALAPPDATA ?? '') => path.join(localAppData, 'agy', 'bin', 'agy.exe');

/**
 * Whether this PC really has the provider set up, so its usage can be read: a subscription with its key file (and the
 * config folder that file names), or the default one (subscription, no key file) with ~/.claude; agy with its program.
 * Only for the methods that read; 'none' is never set up for reading.
 */
export function isConfigured(p: ProviderInfo, deps: ConfiguredDeps = {}): boolean {
  if (p.usage === 'agy') return fs.existsSync(agyExe(deps.localAppData));
  if (p.usage !== 'claude-usage') return false;
  const keyFile = path.join(deps.keysDir ?? keysDir(), `${p.name}.env`);
  if (fs.existsSync(keyFile)) {
    const dir = keyFileConfigDir(keyFile);
    return !dir || fs.existsSync(dir);
  }
  return p.name === 'subscription' && fs.existsSync(path.join(deps.home ?? os.homedir(), '.claude'));
}
