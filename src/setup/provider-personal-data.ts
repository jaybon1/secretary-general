/**
 * Providers in scripts/lib/providers.json without personalDataAllowed (true or false). Without the value a provider is
 * taken as one personal data must not go to (scripts/lib/providers.ps1 Test-PersonalDataAllowed): its run-job and workspace
 * sessions get no memory tools, and run-job does not run in the secretary folder. The install check tells the Claude Code
 * ones (type claude-*, the ones memory tools could go to); a release update (scripts/update.mjs finish) fills in true for
 * the Claude subscriptions, the user's own accounts, and leaves every other provider for the user to decide.
 */
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export interface ProviderEntry {
  name: string;
  type: string;
}

type Providers = Record<string, { type?: unknown; personalDataAllowed?: unknown } | null>;

/** The file's providers with no true/false personalDataAllowed (a "true" in quotes counts as none, as in providers.ps1); null when the file is missing or not JSON. */
export function providersWithoutPersonalData(file: string): ProviderEntry[] | null {
  const read = readProviders(file);
  if (!read.ok) return null;
  return Object.entries(read.providers)
    .filter(([, p]) => typeof p?.personalDataAllowed !== 'boolean')
    .map(([name, p]) => ({ name, type: typeof p?.type === 'string' ? p.type : '' }));
}

/** A Claude Code provider (claude-subscription, claude-api-key, claude-bedrock, claude-gateway): the ones memory tools may go to. */
export const isClaudeCode = (p: ProviderEntry): boolean => p.type.startsWith('claude-');

export interface FillResult {
  /** Subscriptions that got "personalDataAllowed": true. */
  filled: string[];
  /** Providers still without the value, for the user to decide. */
  left: ProviderEntry[];
  /** Why nothing could be done (no file, not JSON, an entry the text edit could not place). */
  problem?: string;
}

/**
 * Puts "personalDataAllowed": true into every claude-subscription provider that has no such key, in the file's own layout
 * (after its "type", with the indent the entry uses), so the rest of the file stays as the user wrote it. Each edit is
 * checked by parsing the file again: if anything but that one key would change, the file is left as it was. A provider
 * whose value is there but not true/false is left for the user too (it is not overwritten).
 */
export function fillSubscriptionPersonalData(file: string, { dryRun = false } = {}): FillResult {
  const read = readProviders(file);
  if (!read.ok) return { filled: [], left: [], problem: read.problem };
  let text = read.text;
  const filled: string[] = [];
  for (const [name, p] of Object.entries(read.providers)) {
    if (p?.type !== 'claude-subscription' || (p && 'personalDataAllowed' in p)) continue;
    const next = insertTrue(text, name);
    if (next === null) return { filled: [], left: providersWithoutPersonalData(file) ?? [], problem: `${name}에 personalDataAllowed를 넣을 자리를 못 찾음(파일은 그대로)` };
    text = next;
    filled.push(name);
  }
  if (filled.length && !dryRun) fs.writeFileSync(file, (read.bom ? '﻿' : '') + text);
  const now = JSON.parse(text) as { providers?: Providers };
  const left = Object.entries(now.providers ?? {})
    .filter(([, q]) => typeof q?.personalDataAllowed !== 'boolean')
    .map(([name, q]) => ({ name, type: typeof q?.type === 'string' ? q.type : '' }));
  return { filled, left };
}

function readProviders(file: string): { ok: true; text: string; bom: boolean; providers: Providers } | { ok: false; problem: string } {
  if (!fs.existsSync(file)) return { ok: false, problem: `${file} 없음` };
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.startsWith('﻿');
  const text = bom ? raw.slice(1) : raw;
  try {
    const j = JSON.parse(text) as { providers?: unknown };
    const providers = j.providers && typeof j.providers === 'object' ? (j.providers as Providers) : {};
    return { ok: true, text, bom, providers };
  } catch (e) {
    return { ok: false, problem: `JSON을 못 읽음(${(e as Error).message})` };
  }
}

/** The index just past the brace that closes the one opening at `open` (strings skipped), or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** text with "personalDataAllowed": true after provider name's "type", or null when that place is not found for sure. */
function insertTrue(text: string, name: string): string | null {
  const providersAt = text.search(/"providers"\s*:\s*\{/);
  if (providersAt < 0) return null;
  const key = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}"\\s*:\\s*\\{`, 'g');
  key.lastIndex = providersAt + 1;
  const m = key.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const end = closing(text, open);
  if (end < 0) return null;
  const body = text.slice(open + 1, end - 1);
  const type = /"type"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(body);
  if (!type) return null;
  // The space before the entry's first key: a new line and its indent, or one space in a one-line entry.
  const gap = /^\s*/.exec(body)![0] || ' ';
  const at = open + 1 + type.index + type[0].length;
  const out = `${text.slice(0, at)},${gap}"personalDataAllowed": true${text.slice(at)}`;
  // Nothing but that one key may change.
  try {
    const before = JSON.parse(text) as { providers: Providers };
    const after = JSON.parse(out) as { providers: Providers };
    const want = { ...before, providers: { ...before.providers, [name]: { ...before.providers[name], personalDataAllowed: true } } };
    return isDeepStrictEqual(after, want) ? out : null;
  } catch {
    return null;
  }
}
