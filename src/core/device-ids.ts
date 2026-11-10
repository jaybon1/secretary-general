/**
 * External devices' ids (scripts/external-devices/devices-config.ts): four upper-case letters from the secretary id's
 * alphabet (setup/secretary-id.ts), so a device id reads like a secretary id and never spells a word. A new one is unlike
 * every secretary id this PC knows (knownSecretaryIds) and every device id already there: one id names one thing on this PC.
 * The device's Tailscale name sits beside it (tailscaleName), so renaming the device in Tailscale changes that one line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { PROJECT_ROOT } from './config.ts';
import { sharedDir } from './this-secretary.ts';
import { readSecretaryId, SECRETARY_ID_ALPHABET, SECRETARY_ID_LENGTH, SECRETARY_ID_PATTERN } from '../setup/secretary-id.ts';

/** SECRETARY_<name>_DIR variables that are no secretary's folder (the keys, skills and shared folders, core/provider-accounts.ts, paths.ts, this-secretary.ts). */
const NOT_IDS = new Set(['KEYS', 'SKILLS', 'SHARED']);

/** The id folders in dir (upper-case letters and digits; the shared names beside them, keys, logs, usage…, are lower case). */
function idFolders(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SECRETARY_ID_PATTERN.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The secretary ids this PC knows: this secretary's (.secretary-id), the id folders in the PC's shared folder
 * (~/.secretary/<id>, and ~/.secretary/state/<id>, ~/.secretary/logs/<id> where they were until 2026-11-09) and the
 * SECRETARY_<id>_DIR variables (core/paths.ts secretaryDirEnv).
 */
export function knownSecretaryIds(root = PROJECT_ROOT, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set<string>();
  const own = readSecretaryId(root);
  if (own) ids.add(own);
  const shared = sharedDir(env);
  for (const dir of [shared, path.join(shared, 'state'), path.join(shared, 'logs')]) for (const id of idFolders(dir)) ids.add(id);
  for (const k of Object.keys(env)) {
    const m = /^SECRETARY_([A-Z0-9]{4,12})_DIR$/.exec(k);
    if (m && !NOT_IDS.has(m[1])) ids.add(m[1]);
  }
  return ids;
}

/** A new device id, unlike every one in taken (any case). */
export function newDeviceId(taken: Iterable<string>, random: (n: number) => number = randomInt): string {
  const used = new Set([...taken].map((t) => t.toUpperCase()));
  for (;;) {
    const id = Array.from({ length: SECRETARY_ID_LENGTH }, () => SECRETARY_ID_ALPHABET[random(SECRETARY_ID_ALPHABET.length)]).join('');
    if (!used.has(id)) return id;
  }
}
