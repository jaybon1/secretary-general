/**
 * The usage guard's override for the prompt hook (notice 'guard-override'): the "keep going past 90%"
 * phrase lifts the guard (scripts/usage/usage-guard.mjs) until the account's 5-hour reset. The lift is kept per account
 * (usage/files.ts overrideFile, guard-override-subscription-<account>.json), so other accounts and another secretary on
 * this PC logged in as another account stay guarded. Which accounts: the ones named on the phrase's line ("계정 b",
 * "b 계정", "계정 a랑 b"; a provider's own label from providers.json), else this session's account (chatProvider).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AccountDeps } from '../core/provider-accounts.ts';
import { personText } from '../hooks/prompt-sender.ts';
import { chatProvider, LEGACY_OVERRIDE_FILE, onSubscription, overrideFile, readUsage, USAGE_DIR } from './files.ts';
import { labeler, readProviders, type ProviderInfo } from './providers.ts';

/** "90%를 초과하더라도 진행", "90퍼 넘어도 계속" and the like: 90, then 초과/넘…도, then 진행/계속. */
const OVERRIDE_PHRASE = /90\s*(퍼센트|퍼|프로|%)?\s*(를|을|가|이)?\s*(초과|넘)[가-힣]*도\s*(진행|계속)/;

export function isGuardOverride(prompt: string): boolean {
  return OVERRIDE_PHRASE.test(prompt);
}

/** Between names in a list: "a랑 b", "a, b", "a와 b", "a하고 b", "a·b", "a/b". */
const JOIN = String.raw`\s*(?:,|·|/|&|\+|이랑|랑|와|과|하고|및)\s*`;
/** An account id: a, b, b2 (starts with a letter, so "계정 b, 90퍼" doesn't read 90 as one). */
const ID = '[A-Za-z][A-Za-z0-9]*';
/** "계정 b", "계정b가", "계정 a랑 b": the ids after 계정. */
const AFTER = new RegExp(`계정\\s*(${ID}(?:${JOIN}${ID})*)(?![A-Za-z0-9])`, 'g');
/** "b 계정", "a랑 b 계정": the ids before 계정 (not inside a longer ASCII word). */
const BEFORE = new RegExp(`(?<![A-Za-z0-9])(${ID}(?:${JOIN}${ID})*)\\s*계정`, 'g');

export interface NamedAccounts {
  /** Providers named, in providers.json order. */
  providers: string[];
  /** Short account ids said (one or two letters, like "계정 c") that no provider has; a longer word ("github 계정") is not taken for one. */
  unknown: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The accounts named in `text` (the override phrase's line): "계정 <id>" or "<id> 계정" against the providers whose label
 * is "계정 <id>" (계정 a / 계정 b by default), and any other label (two letters or more) said as a whole word. Case and
 * spaces don't matter.
 */
export function namedAccounts(text: string, providers: ProviderInfo[]): NamedAccounts {
  const byId = new Map<string, string>();
  const named = new Set<string>();
  for (const p of providers) {
    const id = new RegExp(`^계정\\s*(${ID})$`).exec(p.label)?.[1];
    if (id) {
      byId.set(id.toLowerCase(), p.name);
      continue;
    }
    const label = p.label.replace(/\s+/g, '');
    if (label.length < 2) continue;
    const words = [...label].map(escape).join('\\s*');
    if (new RegExp(`(?<![A-Za-z0-9])${words}(?![A-Za-z0-9])`, 'i').test(text)) named.add(p.name);
  }
  const unknown = new Set<string>();
  for (const re of [AFTER, BEFORE]) {
    for (const m of text.matchAll(re)) {
      for (const id of m[1].split(new RegExp(JOIN))) {
        const name = byId.get(id.toLowerCase());
        if (name) named.add(name);
        else if (id.length <= 2) unknown.add(id);
      }
    }
  }
  return { providers: providers.map((p) => p.name).filter((n) => named.has(n)), unknown: [...unknown] };
}

export interface OverrideDeps {
  /** Where the lifts and usage files are (~/.claude/usage). */
  dir?: string;
  /** How a provider's login account is found (overrideFile). */
  account?: AccountDeps;
  /** providers.json as read (labels, names). */
  providers?: ProviderInfo[];
  /** This session's environment (onSubscription: an API key or Bedrock chat is never stopped). */
  env?: NodeJS.ProcessEnv;
}

/**
 * If the person typed the override phrase, lift the guard until each named account resets (or 5 hours);
 * with no account named on the phrase's line, this session's account. A named account no provider has is not lifted and
 * the notice says so (lifting another account instead would undo the guard the person did not mean to). An account the
 * guard never stops (not a Claude subscription by its providers.json type, or this chat on an API key / Bedrock) is not
 * lifted either, and the notice says it was never stopped.
 * Only the person's words count (personText): another session's message, a subagent's report or a task
 * notice may quote the phrase.
 * The old lift for every account (guard-override.json in `dir`) is deleted then; the guard no longer reads it.
 */
export function applyGuardOverride(prompt: string, now = Date.now(), provider = chatProvider(), deps: OverrideDeps = {}): string {
  const said = personText(prompt);
  if (!isGuardOverride(said)) return '';
  const dir = deps.dir ?? USAGE_DIR;
  const read = deps.providers ?? readProviders(deps.account?.root);
  const label = labeler(read);
  // This session's account can always be named, even when providers.json can't be read or doesn't list it.
  const list = read.some((p) => p.name === provider) ? read : [...read, { name: provider, type: '', label: label(provider), usage: 'none' as const }];
  const line = said.split(/\r?\n/).find((l) => isGuardOverride(l)) ?? said;
  const named = namedAccounts(line, list);
  const asked = named.providers.length ? named.providers : named.unknown.length ? [] : [provider];
  const known = list.map((p) => p.label).join(', ');
  if (!asked.length) {
    return `<secretary-usage>사용량 정지 장치를 풀지 않았어요. 사용자가 말한 계정(${named.unknown.join(', ')})이 공급자 목록에 없어요(있는 계정: ${known || '없음'}). 어느 계정을 풀지 사용자에게 물어 주세요.</secretary-usage>`;
  }
  // The guard stops only Claude Code on a subscription; lifting any other would tell the person it was stopped when it never was.
  const typeOf = new Map(list.map((p) => [p.name, p.type]));
  const guarded = (p: string) => ['', 'claude-subscription'].includes(typeOf.get(p) ?? '') && (p !== provider || onSubscription(deps.env));
  const targets = asked.filter(guarded);
  const free = asked.filter((p) => !guarded(p)).map((p) => label(p));
  const freeNote = free.length ? `${free.join(', ')}는 사용량 정지 장치 대상이 아니에요(Claude 구독이 아니라 처음부터 막지 않아요).` : '';
  if (!targets.length) {
    return `<secretary-usage>사용량 정지 장치를 풀지 않았어요. ${freeNote} 사용자에게 그대로 알려 주세요.</secretary-usage>`;
  }
  const lifted: string[] = [];
  for (const p of targets) {
    const file = overrideFile(p, dir, deps.account);
    const resets = readUsage(p, dir, deps.account)?.resets_at;
    const until = resets && Date.parse(resets) > now ? resets : new Date(now + 5 * 3600_000).toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ until, set_at: new Date(now).toISOString(), provider: p }));
    lifted.push(`${p === 'subscription' && read.length < 2 ? '5시간 사용량' : label(p)} 초기화(${until})`);
  }
  try {
    fs.rmSync(path.join(dir, path.basename(LEGACY_OVERRIDE_FILE)), { force: true });
  } catch {}
  const notes = [
    targets.includes(provider) ? '' : ` 이 대화의 ${label(provider)}는 그대로예요.`,
    named.unknown.length && named.providers.length ? ` 목록에 없는 계정(${named.unknown.join(', ')})은 풀지 않았어요.` : '',
    freeNote ? ` ${freeNote}` : '',
  ].join('');
  return `<secretary-usage>사용량 정지 장치를 ${lifted.join(', ')}까지 풀었어요.${notes} 사용자가 지금 일에 한해 90%를 넘어도 진행하라고 했어요.</secretary-usage>`;
}
