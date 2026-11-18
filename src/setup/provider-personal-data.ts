/**
 * Providers in scripts/lib/providers.json without personalDataAllowed (true or false). Without the value a provider is
 * taken as one personal data must not go to (scripts/lib/providers.ps1 Test-PersonalDataAllowed): its run-job and workspace
 * sessions get no memory tools, and run-job does not run in the secretary folder. The install check tells the Claude Code
 * ones (type claude-*, the ones memory tools could go to), and the user decides each value.
 */
import fs from 'node:fs';

export interface ProviderEntry {
  name: string;
  type: string;
}

type Providers = Record<string, { type?: unknown; personalDataAllowed?: unknown } | null>;

/** The file's providers with no true/false personalDataAllowed (a "true" in quotes counts as none, as in providers.ps1); null when the file is missing or not JSON. */
export function providersWithoutPersonalData(file: string): ProviderEntry[] | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  let providers: Providers;
  try {
    const j = JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw) as { providers?: unknown };
    providers = j.providers && typeof j.providers === 'object' ? (j.providers as Providers) : {};
  } catch {
    return null;
  }
  return Object.entries(providers)
    .filter(([, p]) => typeof p?.personalDataAllowed !== 'boolean')
    .map(([name, p]) => ({ name, type: typeof p?.type === 'string' ? p.type : '' }));
}

/** A Claude Code provider (claude-subscription, claude-api-key, claude-bedrock, claude-gateway): the ones memory tools may go to. */
export const isClaudeCode = (p: ProviderEntry): boolean => p.type.startsWith('claude-');
