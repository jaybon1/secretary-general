/**
 * Which providers' usage is read (the usage reader, usage-poller.ts) and shown (the dashboard): this PC's choice in
 * scripts/usage.local.json (not committed, UTF-8 without a BOM; the dashboard's /settings page writes it, or the
 * secretary by hand where the dashboard is off):
 *   { "providers": ["subscription", "subscription-b"] }
 * Only names in scripts/lib/providers.json are kept. Without the file: every provider whose usage can be read
 * (usage/providers.ts) and that is set up on this PC. A checked provider that cannot be read shows as 조회 안 됨.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readLocalJson, writeLocalJson } from '../core/local-file.ts';
import { scriptPath } from '../core/paths.ts';
import { isConfigured, METHOD_TEXT, type ConfiguredDeps, type ProviderInfo } from './providers.ts';

export const usageSettingsFile = (root = PROJECT_ROOT) => scriptPath('usageLocal', root);

export interface UsageChoice {
  /** Checked provider names, in providers.json order. */
  checked: string[];
  /** Whether the file is there (else the default). */
  saved: boolean;
  problem: string | null;
}

/** The default: what can be read and is set up here. */
export function defaultChoice(providers: ProviderInfo[], deps: ConfiguredDeps = {}): string[] {
  return providers.filter((p) => p.usage !== 'none' && isConfigured(p, deps)).map((p) => p.name);
}

export function readUsageChoice(providers: ProviderInfo[], file = usageSettingsFile(), deps: ConfiguredDeps = {}): UsageChoice {
  const r = readLocalJson<{ providers?: unknown }>(file);
  if (r.ok) {
    const v = r.value && typeof r.value === 'object' ? r.value.providers : undefined;
    if (Array.isArray(v)) {
      const names = new Set(v.filter((x): x is string => typeof x === 'string'));
      return { checked: providers.filter((p) => names.has(p.name)).map((p) => p.name), saved: true, problem: null };
    }
    return { checked: defaultChoice(providers, deps), saved: false, problem: `${path.basename(file)}: providers는 공급자 이름 목록` };
  }
  return { checked: defaultChoice(providers, deps), saved: false, problem: r.missing ? null : `${path.basename(file)}을 못 읽음(${r.error.slice(0, 80)})` };
}

/** Saves the choice: input must be a list of names; only known ones are kept (in providers.json order). */
export function saveUsageChoice(input: unknown, providers: ProviderInfo[], file = usageSettingsFile()): string[] {
  const names = input && typeof input === 'object' && !Array.isArray(input) ? (input as { providers?: unknown }).providers : undefined;
  if (!Array.isArray(names) || names.length > 100 || !names.every((n) => typeof n === 'string' && n.length <= 100)) {
    throw new TypeError('providers는 공급자 이름 목록');
  }
  const want = new Set(names);
  const kept = providers.filter((p) => want.has(p.name)).map((p) => p.name);
  writeLocalJson(file, { providers: kept });
  return kept;
}

/** What the settings page shows: each provider, how it is read, whether it is set up here, whether it is checked. */
export function usageSettingsView(providers: ProviderInfo[], choice: UsageChoice, deps: ConfiguredDeps = {}) {
  const checked = new Set(choice.checked);
  return {
    saved: choice.saved,
    problem: choice.problem,
    providers: providers.map((p) => ({
      name: p.name,
      label: p.label,
      method: p.usage,
      methodText: METHOD_TEXT[p.usage],
      readable: p.usage !== 'none',
      configured: p.usage !== 'none' && isConfigured(p, deps),
      checked: checked.has(p.name),
    })),
  };
}
