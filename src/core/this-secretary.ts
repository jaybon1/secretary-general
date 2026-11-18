/**
 * Local settings (never committed, UTF-8), in two files, one section per feature:
 *
 * - this-secretary.local.json at the top of the secretary folder (example this-secretary.local.example.json beside it):
 *   what is this secretary's own. Two secretaries on one PC each keep theirs.
 * - all-secretaries.local.json in the PC's shared folder ~/.secretary/ (SECRETARY_SHARED_DIR in tests; example
 *   all-secretaries.local.example.json at the top of the secretary folder): what every secretary on the PC must use alike
 *   (decided 2026-11-10; which features: their thisSecretary column says shared). The name is in
 *   ALL_SECRETARIES_FILE only.
 *
 * Where a value goes: "if this PC had two secretaries, must both use the same value?" Yes: the shared file. No: this
 * secretary's. Keys always stay in the PC's shared keys folder (core/provider-accounts.ts keysDir). A feature's column in
 * features.json (thisSecretary: { section, shared? }) says which section it has, in which file. "paths" (no feature: the results folder on the other PC,
 * which the session-start hook tells) is this secretary's. Every reader and writer goes through here (PowerShell through
 * scripts/lib/this-secretary.ps1 for this secretary's file).
 *
 * A feature's section is read only while that feature is on: turned off, it reads as missing and the rest of the file is
 * untouched; a copy that leaves a feature out has no code that reads it, and the examples have no such section
 * (scripts/release-build/release-build.mjs).
 *
 * Under the test mark (test/env.ts, local-settings.ts NO_LOCAL_ENV) this copy's own file and the real ~/.secretary file
 * read as missing and are never written; a temp copy's works as always.
 */
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { readJson, type JsonRead } from './json-file.ts';
import { isShieldedLocal, NO_LOCAL_ENV, writeLocalJson } from './local-settings.ts';
import { featureOn, readFeatures } from './features.ts';

export const THIS_SECRETARY_FILE = 'this-secretary.local.json';
export const THIS_SECRETARY_EXAMPLE = 'this-secretary.local.example.json';
/** The PC's shared settings file (named 2026-11-10; the name is here only). */
export const ALL_SECRETARIES_FILE = 'all-secretaries.local.json';
export const ALL_SECRETARIES_EXAMPLE = ALL_SECRETARIES_FILE.replace(/\.json$/, '.example.json');
/** Tests: the PC's shared folder (default ~/.secretary, where the keys folder is too). */
export const SHARED_DIR_ENV = 'SECRETARY_SHARED_DIR';
/** The section no feature owns: paths every copy reads (otherPcRoot). */
export const PATHS_SECTION = 'paths';

const REAL_SHARED_DIR = path.join(os.homedir(), '.secretary');
export const sharedDir = (env = process.env) => env[SHARED_DIR_ENV] || REAL_SHARED_DIR;
export const thisSecretaryFile = (root = PROJECT_ROOT) => path.join(root, THIS_SECRETARY_FILE);
export const allSecretariesFile = (env = process.env) => path.join(sharedDir(env), ALL_SECRETARIES_FILE);

/** this secretary's file, or the PC's shared one. */
export type Place = 'secretary' | 'shared';
const fileOf = (place: Place, root: string, env = process.env) => (place === 'shared' ? allSecretariesFile(env) : thisSecretaryFile(root));
const nameOf = (place: Place) => (place === 'shared' ? ALL_SECRETARIES_FILE : THIS_SECRETARY_FILE);

/** Under the test mark: this copy's own file, and the real shared one (whatever a test set the folder to). */
function shielded(place: Place, root: string, env = process.env): boolean {
  if (place === 'secretary') return isShieldedLocal(thisSecretaryFile(root), env);
  return !!env[NO_LOCAL_ENV] && path.resolve(sharedDir(env)).toLowerCase() === path.resolve(REAL_SHARED_DIR).toLowerCase();
}

type Sections = Record<string, unknown>;

/** A whole file: {} when it is not there, or why it cannot be read. */
function readAll(place: Place, root: string): JsonRead<Sections> {
  if (shielded(place, root)) return { ok: true, value: {} };
  const r = readJson<Sections>(fileOf(place, root));
  if (!r.ok) return r.missing ? { ok: true, value: {} } : r;
  if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { ok: false, missing: false, error: `${nameOf(place)}: 맨 위가 { 키 이름: 값 }이 아님` };
  return r;
}

/**
 * Whether a section is read in this copy: paths always; a feature's while one of `features` (default: the section's own
 * id) is on. As everywhere (core/features.ts), no features.json, or a feature it does not list, counts as on; a copy that
 * leaves a feature out has no code that reads its section.
 */
export function sectionOn(section: string, root = PROJECT_ROOT, features: string[] = [section]): boolean {
  if (section === PATHS_SECTION) return true;
  const list = readFeatures(root);
  if (!list) return true;
  return features.some((id) => {
    const f = list.find((x) => x.id === id);
    return !f || featureOn(f);
  });
}

export interface ReadOptions {
  root?: string;
  /** The features that read this section (any of them on is enough); default the section's own id. */
  features?: string[];
  /** In the PC's shared file (all-secretaries.local.json) rather than this secretary's. */
  shared?: boolean;
}

/** A section's value; missing when there is no file, no such section, or its feature is off. */
export function readThisSecretary<T>(section: string, { root = PROJECT_ROOT, features, shared }: ReadOptions = {}): JsonRead<T> {
  if (!sectionOn(section, root, features)) return { ok: false, missing: true, error: `기능 '${section}'이 꺼져 있음` };
  const place: Place = shared ? 'shared' : 'secretary';
  const all = readAll(place, root);
  if (!all.ok) return all;
  if (!(section in all.value) || all.value[section] === undefined) return { ok: false, missing: true, error: `${nameOf(place)}에 '${section}' 키 없음` };
  return { ok: true, value: all.value[section] as T };
}

/** Whether this secretary's file (or the shared one) has the section at all, whatever its feature: the install check asks first. */
export function hasThisSecretary(section: string, root = PROJECT_ROOT, shared = false): boolean {
  const all = readAll(shared ? 'shared' : 'secretary', root);
  return all.ok && section in all.value;
}

/** Writes one section, keeping the others; refuses a file that does not parse (it would be lost) and a shielded one under the test mark. */
export function writeThisSecretary(section: string, value: unknown, root = PROJECT_ROOT, shared = false): void {
  const place: Place = shared ? 'shared' : 'secretary';
  writeSections(place, root, { [section]: value });
}

function writeSections(place: Place, root: string, sections: Sections): void {
  if (shielded(place, root)) throw new Error(`테스트 중에는 이 설정 파일을 쓰지 않음: ${fileOf(place, root)}`);
  const all = readAll(place, root);
  if (!all.ok) throw new Error(`${nameOf(place)}을 못 읽어 쓰지 않음(고친 뒤 다시): ${all.error}`);
  writeLocalJson(fileOf(place, root), { ...all.value, ...sections });
}
