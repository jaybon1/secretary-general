/**
 * The dashboard's settings: defaults here, this PC's own values in scripts/dashboard.local.json (not committed, made by
 * hand when the defaults don't fit). The secretary folder is not a setting: the dashboard runs from it (PROJECT_ROOT).
 *
 * scripts/dashboard.local.json (every field optional):
 *   hosts      addresses to listen on besides 127.0.0.1, which is always there (Tailscale Serve forwards to it), e.g. this
 *              PC's tailnet address "100.x.x.x" for the plain http address on other devices
 *   port       default 8790
 *   publicUrl  the address phones open, e.g. "https://<device>.<tailnet>.ts.net" (Tailscale Serve): `urls` prints it
 *   recentDone how many finished, cancelled and failed tasks the board shows (default 8)
 *   refreshSec page refresh (default 30)
 *   share      { name: folder } read-only result folders under /share/<name>/ (a relative folder is from the secretary
 *              folder; null drops a default). Default: ai-agent = the secretary's parent folder only (inbox and notes
 *              are seen inside it, /share/ai-agent/inbox/, the same path as on a PC that maps the share above ai-agent).
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readLocalJson } from '../core/local-file.ts';
import { scriptPath } from '../core/paths.ts';
import { featureOn, readFeatures } from '../setup/features.ts';

export const FEATURE_ID = 'dashboard';
export const DEFAULT_PORT = 8790;
export const LOOPBACK = '127.0.0.1';

export interface DashboardSettings {
  hosts: string[];
  port: number;
  publicUrl: string | null;
  recentDone: number;
  refreshSec: number;
  /** name → absolute folder */
  share: Record<string, string>;
}

/** A share name as it appears in the address: letters, digits, Korean, . _ - (not . or ..). */
export const SHARE_NAME = /^(?!\.{1,2}$)[\p{L}\p{N}._-]+$/u;

export function defaultShare(root = PROJECT_ROOT): Record<string, string> {
  const parent = path.dirname(root);
  return { 'ai-agent': parent };
}

export const settingsFile = (root = PROJECT_ROOT) => scriptPath('dashboardLocal', root);

/** Defaults with the local file over them; problem says what in the file was not taken (the rest still is). */
export function readSettings(root = PROJECT_ROOT, file = settingsFile(root)): { settings: DashboardSettings; problem: string | null } {
  const problems: string[] = [];
  const r = readLocalJson<Record<string, unknown>>(file);
  const local: Record<string, unknown> = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  if (!r.ok && !r.missing) problems.push(`${path.basename(file)}을 못 읽음(${r.error.slice(0, 80)})`);
  const int = (k: string, def: number, min: number, max: number) => {
    const v = local[k];
    if (v === undefined) return def;
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
    problems.push(`${k}=${JSON.stringify(v)} 무시`);
    return def;
  };
  const hosts = [LOOPBACK];
  if (local.hosts !== undefined) {
    if (Array.isArray(local.hosts) && local.hosts.every((h) => typeof h === 'string' && h)) {
      for (const h of local.hosts as string[]) if (!hosts.includes(h)) hosts.push(h);
    } else problems.push('hosts는 주소 글의 목록');
  }
  const share = defaultShare(root);
  if (local.share !== undefined) {
    if (local.share && typeof local.share === 'object' && !Array.isArray(local.share)) {
      for (const [name, dir] of Object.entries(local.share as Record<string, unknown>)) {
        if (!SHARE_NAME.test(name)) problems.push(`share 이름 '${name}' 무시`);
        else if (dir === null) delete share[name];
        else if (typeof dir === 'string' && dir) share[name] = path.resolve(root, dir);
        else problems.push(`share '${name}' 무시`);
      }
    } else problems.push('share는 { 이름: 폴더 }');
  }
  const publicUrl = typeof local.publicUrl === 'string' && /^https?:\/\/[^\s/]+\/?$/.test(local.publicUrl) ? local.publicUrl.replace(/\/$/, '') : null;
  if (local.publicUrl !== undefined && !publicUrl) problems.push('publicUrl은 https://주소 꼴');
  return {
    settings: {
      hosts,
      port: int('port', DEFAULT_PORT, 1, 65535),
      publicUrl,
      recentDone: int('recentDone', 8, 1, 100),
      refreshSec: int('refreshSec', 30, 5, 3600),
      share,
    },
    problem: problems.length ? problems.join(', ') : null,
  };
}

/** Whether the feature is on in this copy's features.json (on without the file, like every feature). */
export function dashboardOn(root = PROJECT_ROOT): boolean {
  const f = (readFeatures(root) ?? []).find((x) => x.id === FEATURE_ID);
  return !f || featureOn(f);
}

/** The addresses to open: each listened one, then the public one. */
export function dashboardUrls(s: DashboardSettings): string[] {
  return [...s.hosts.map((h) => `http://${h.includes(':') ? `[${h}]` : h}:${s.port}/`), ...(s.publicUrl ? [`${s.publicUrl}/`] : [])];
}
