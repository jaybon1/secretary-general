/**
 * The TypeScript side of scripts/lib/providers.ps1: which Claude accounts this PC has. Providers are listed in
 * scripts/lib/providers.json; a second subscription keeps CLAUDE_CONFIG_DIR=<its config folder> in the keys
 * folder's <provider>.env (account b: ~/.claude-b).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { scriptPath, SECRETARY_HOME } from './paths.ts';
import { readJsonFile } from './json-file.ts';

export function keysDir(env = process.env): string {
  return env.SECRETARY_KEYS_DIR || path.join(SECRETARY_HOME, 'keys');
}

/** CLAUDE_CONFIG_DIR from a key file (only that line is read), %VARS% expanded; undefined if none. */
export function keyFileConfigDir(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^\s*CLAUDE_CONFIG_DIR\s*=\s*(.*?)\s*$/m.exec(text);
  if (!m) return undefined;
  return m[1].replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all);
}

/**
 * Config folders of every Claude account here: the current process's, ~/.claude (account a), and each
 * subscription provider's own (Get-AccountConfigDirs in providers.ps1 lists the same places).
 */
export function accountConfigDirs(root = PROJECT_ROOT, env = process.env): string[] {
  const config = readJsonFile<{ providers?: Record<string, { type?: string }> }>(scriptPath('providers', root));
  const extra = Object.entries(config?.providers ?? {})
    .filter(([, p]) => p.type === 'claude-subscription')
    .map(([name]) => keyFileConfigDir(path.join(keysDir(env), `${name}.env`)));
  return [...new Set([env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude'), ...extra].filter(Boolean) as string[])];
}

/**
 * The home folder whose .claude.json is this PC's default login (~/.claude.json). SECRETARY_LOGIN_HOME moves it: the
 * tests point it at their temp folder (test/env.ts) so they never read this PC's login. scripts/lib/providers.ps1 does the same.
 */
export const loginHome = (env = process.env): string => env.SECRETARY_LOGIN_HOME || os.homedir();

export interface AccountDeps {
  /** The secretary folder whose scripts/lib/providers.json says which providers are Claude subscriptions. */
  root?: string;
  keysDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Read the login as the provider's own clean environment would (Clear-HostClaudeEnv + Use-Provider): its key file's
   * CLAUDE_CONFIG_DIR, else the default login, never this process's CLAUDE_CONFIG_DIR. For other providers' names now
   * (dropLegacyUsageFiles), so an odd environment here doesn't take another provider's real file for an old one.
   */
  clean?: boolean;
}

/**
 * Where a provider's login is kept (.claude.json), for a Claude subscription only (null for any other provider: an API
 * key, a gateway or another company's CLI has no such login). The folder Use-Provider (providers.ps1) runs it with:
 * CLAUDE_CONFIG_DIR from its key file; else, for the provider this process runs on (SECRETARY_PROVIDER), this process's
 * CLAUDE_CONFIG_DIR; else the default login (~/.claude.json). Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR.
 * The PowerShell side: Get-ProviderLoginFile in scripts/lib/providers.ps1 (same rule).
 */
export function providerLoginFile(provider: string, d: AccountDeps = {}): string | null {
  const env = d.env ?? process.env;
  const config = readJsonFile<{ providers?: Record<string, { type?: string }> }>(scriptPath('providers', d.root ?? PROJECT_ROOT));
  if (config?.providers?.[provider]?.type !== 'claude-subscription') return null;
  const dir =
    keyFileConfigDir(path.join(d.keysDir ?? keysDir(env), `${provider}.env`)) ||
    (!d.clean && (env.SECRETARY_PROVIDER || 'subscription') === provider ? env.CLAUDE_CONFIG_DIR : undefined);
  return dir ? path.join(dir, '.claude.json') : path.join(loginHome(env), '.claude.json');
}

/** Each login file is read again only when it changed (the prompt hook asks on every question; the dashboard keeps running). */
const accountCache = new Map<string, { mtimeMs: number; account: string | null }>();

/** The account in a login file: its oauthAccount.emailAddress before the @. null when the file or the address is not there. */
export function loginAccount(file: string): string | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = accountCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.account;
  let account: string | null = null;
  try {
    const email: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.oauthAccount?.emailAddress;
    if (typeof email === 'string') account = email.split('@')[0].trim() || null;
  } catch {}
  accountCache.set(file, { mtimeMs, account });
  return account;
}

/** The account a provider logs in as (e.g. hong for hong@example.com), or null: not a Claude subscription, or its login can't be read. */
export function providerAccount(provider: string, d: AccountDeps = {}): string | null {
  const file = providerLoginFile(provider, d);
  return file ? loginAccount(file) : null;
}
