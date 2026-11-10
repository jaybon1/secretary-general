/**
 * The devices of this PC's tailnet, as `tailscale status --json` lists them: an external device is named by its Tailscale
 * device name (the name `tailscale status` shows, the first label of its MagicDNS name). Used by the merge of a device's old
 * settings file (core/this-secretary.ts: its host address gets the device's name) and the install check (setup/check-items.ts:
 * device names that are not in the tailnet). Never called under the test mark: tests hand in the output.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NO_LOCAL_ENV } from './local-settings.ts';

export interface TailscaleDevice {
  /** The name `tailscale status` shows (MagicDNS name's first label, lower case). */
  name: string;
  /** The machine's own host name (lower case). */
  hostName: string;
  ips: string[];
}

/** The devices in `tailscale status --json` output (this PC and its peers); [] when it does not parse. */
export function parseTailscaleStatus(text: string): TailscaleDevice[] {
  let v: { Self?: Peer; Peer?: Record<string, Peer> };
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  type Peer = { DNSName?: string; HostName?: string; TailscaleIPs?: string[] };
  const peers = [v.Self, ...Object.values(v.Peer ?? {})].filter((p): p is Peer => !!p && typeof p === 'object');
  return peers.map((p) => {
    const host = (p.HostName ?? '').toLowerCase();
    const dns = (p.DNSName ?? '').split('.')[0].toLowerCase();
    return { name: dns || host, hostName: host, ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [] };
  }).filter((d) => d.name);
}

/** tailscale.exe: the usual install folder, else PATH. */
function tailscaleExe(env: NodeJS.ProcessEnv): string {
  const installed = path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  return fs.existsSync(installed) ? installed : 'tailscale';
}

/** `tailscale status --json` output, or null when tailscale is not there or not running, and always under the test mark. */
export function readTailscaleStatus(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[NO_LOCAL_ENV]) return null;
  const r = spawnSync(tailscaleExe(env), ['status', '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** The device a host (an address, a MagicDNS name, or a device name) is, or null. */
export function findTailscaleDevice(devices: TailscaleDevice[], host: string): TailscaleDevice | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const label = h.split('.')[0];
  const byIp = devices.find((d) => d.ips.includes(h));
  if (byIp || /^[\d.]+$|:/.test(h)) return byIp ?? null;
  return devices.find((d) => d.name === h || d.name === label || d.hostName === h) ?? null;
}
