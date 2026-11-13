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
 * features.json (thisSecretary: { section, shared?, from? }) says which section it has, in which file, and the separate
 * files it came from (scripts/*.local.json until 2026-11-10). "paths" (no feature: the results folder on the other PC,
 * which the session-start hook tells) is this secretary's. Every reader and writer goes through here (PowerShell through
 * scripts/lib/this-secretary.ps1 for this secretary's file; the external devices only through scripts/external-devices/devices-config.ts).
 *
 * A feature's section is read only while that feature is on: turned off, it reads as missing and the rest of the file is
 * untouched; a copy that leaves a feature out has no code that reads it, and the examples have no such section
 * (scripts/release-build/release-build.mjs).
 *
 * The separate files are not read any more: `node src/cli.ts this-secretary-merge` (--dry-run to look first) puts each into
 * its section (in its file) and moves it, whole, to backups/this-secretary-merge/<time>/; a release's update does the same
 * (scripts/update.mjs). A value already there is never overwritten: a file with a value that differs stays where it is,
 * and the install check (renamed-local-files) names it. A device's old settings need its Tailscale name (from
 * `tailscale status`, core/tailscale.ts): without it the file stays too. It gets a device id of its own (core/device-ids.ts)
 * with the Tailscale name beside it, and the line says the pair. Running it again does nothing more.
 *
 * Under the test mark (test/env.ts, local-settings.ts NO_LOCAL_ENV) this copy's own file and the real ~/.secretary file
 * read as missing and are never written or merged; a temp copy's works as always.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { readJson, type JsonRead } from './json-file.ts';
import { isShieldedLocal, NO_LOCAL_ENV, writeLocalJson } from './local-settings.ts';
import { formatLocal } from './kst-time.ts';
import { findTailscaleDevice, parseTailscaleStatus, readTailscaleStatus, type TailscaleDevice } from './tailscale.ts';
import { knownSecretaryIds, newDeviceId } from './device-ids.ts';
import { featureOn, readFeatures, type Feature, type ThisSecretaryColumn, type ThisSecretarySource } from './features.ts';

export const THIS_SECRETARY_FILE = 'this-secretary.local.json';
export const THIS_SECRETARY_EXAMPLE = 'this-secretary.local.example.json';
/** The PC's shared settings file (named 2026-11-10; the name is here only). */
export const ALL_SECRETARIES_FILE = 'all-secretaries.local.json';
export const ALL_SECRETARIES_EXAMPLE = ALL_SECRETARIES_FILE.replace(/\.json$/, '.example.json');
/** Tests: the PC's shared folder (default ~/.secretary, where the keys folder is too). */
export const SHARED_DIR_ENV = 'SECRETARY_SHARED_DIR';
/** The section no feature owns: paths every copy reads (otherPcRoot). */
export const PATHS_SECTION = 'paths';
/** Where the merge keeps the separate files it took in (under the secretary folder, git-ignored with backups/). */
export const MERGE_BACKUP_DIR = 'backups/this-secretary-merge';

const REAL_SHARED_DIR = path.join(os.homedir(), '.secretary');
export const sharedDir = (env = process.env) => env[SHARED_DIR_ENV] || REAL_SHARED_DIR;
export const thisSecretaryFile = (root = PROJECT_ROOT) => path.join(root, THIS_SECRETARY_FILE);
export const allSecretariesFile = (env = process.env) => path.join(sharedDir(env), ALL_SECRETARIES_FILE);

/** this secretary's file, or the PC's shared one. */
export type Place = 'secretary' | 'shared';
const fileOf = (place: Place, root: string, env = process.env) => (place === 'shared' ? allSecretariesFile(env) : thisSecretaryFile(root));
const nameOf = (place: Place) => (place === 'shared' ? ALL_SECRETARIES_FILE : THIS_SECRETARY_FILE);
const placeOf = (col: { shared?: boolean }): Place => (col.shared ? 'shared' : 'secretary');

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

// ---- merging the separate files in --------------------------------------------------------------- legacy-name: this-secretary-merge

type State = 'add' | 'same' | 'differs' | 'empty' | 'held' | 'unresolved';

/** One separate file and the sections it goes to. */
export interface MergeItem {
  /** Path from the secretary folder, with /. */
  file: string;
  /** Each part of it: the section, its file, and what happens to it. */
  parts: { section: string; place: Place; state: State; why?: string; note?: string }[];
  /** Why it cannot be taken (not JSON), when it cannot. */
  error?: string;
  /** Whether the whole file can go to the backup folder: every part added, the same, or empty. */
  done: boolean;
}

const asSource = (s: ThisSecretarySource) => (typeof s === 'string' ? { file: s } : s);

/** The part of an old file's value a section takes (pick or omit on an object; anything else whole). */
function partOf(value: unknown, src: { pick?: string[]; omit?: string[] }): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(src.pick || src.omit)) return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => (src.pick ? src.pick.includes(k) : !src.omit!.includes(k)));
  return Object.fromEntries(entries);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || (isObject(v) && !Object.keys(v).length);

/** Order-free comparison of two JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const [ka, kb] = [Object.keys(a), Object.keys(b)];
    return ka.length === kb.length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return a === b;
}

/**
 * part into what is there, never overwriting: objects key by key, anything else (a list, a value) whole. 'differs' when a
 * value there is not the part's, 'same' when nothing would change, else 'add' with the result.
 */
function mergeInto(there: unknown, part: unknown): { state: 'add' | 'same' | 'differs'; value: unknown } {
  if (there === undefined) return { state: 'add', value: part };
  if (isObject(there) && isObject(part)) {
    const value: Record<string, unknown> = { ...there };
    let state: 'add' | 'same' = 'same';
    for (const [k, v] of Object.entries(part)) {
      const r = mergeInto(there[k], v);
      if (r.state === 'differs') return { state: 'differs', value: there };
      if (r.state === 'add') (state = 'add'), (value[k] = r.value);
    }
    return { state, value };
  }
  return { state: sameJson(there, part) ? 'same' : 'differs', value: there };
}

/** What a transform needs besides the old file's value. */
interface TransformCtx {
  root: string;
  /** The tailnet's devices (core/tailscale.ts); null when tailscale could not be read. */
  devices: () => TailscaleDevice[] | null;
  /** The sections as they are now (with what the merge has taken so far), per file. */
  now: Record<Place, Sections>;
  /** The section the part goes to. */
  section: string;
  dryRun: boolean;
}

/** The device a host is in the tailnet, by name (core/tailscale.ts); why not when it cannot be told. */
function deviceName(host: string, ctx: TransformCtx): { name?: string; why?: string } {
  const devices = ctx.devices();
  if (!devices) return { why: 'tailscale status를 못 읽어 기기 이름을 모름(Tailscale이 켜져 있는지 본 뒤 다시)' };
  const d = findTailscaleDevice(devices, host);
  return d ? { name: d.name } : { why: `tailscale status에 주소 ${host}인 기기가 없음(기기 이름을 사용자에게 물어 직접 적는다)` };
}

/** The devices already in the section (now, with what the merge has taken so far), by id. */
function devicesThere(ctx: TransformCtx): Record<string, Record<string, unknown>> {
  const there = ctx.now.shared[ctx.section] ?? ctx.now.secretary[ctx.section];
  return isObject(there) && isObject(there.devices) ? (there.devices as Record<string, Record<string, unknown>>) : {};
}

/** The id of the device there with this Tailscale name (any case), if any. */
function idThere(tailscaleName: string, ctx: TransformCtx): string | undefined {
  return Object.entries(devicesThere(ctx)).find(([, d]) => isObject(d) && typeof d.tailscaleName === 'string' && d.tailscaleName.toLowerCase() === tailscaleName.toLowerCase())?.[0];
}

/** The id of the device with this Tailscale name: the one there, else a new one unlike every id this PC knows (core/device-ids.ts). */
function deviceId(tailscaleName: string, ctx: TransformCtx): { id: string; made: boolean } {
  const id = idThere(tailscaleName, ctx);
  return id ? { id, made: false } : { id: newDeviceId([...knownSecretaryIds(ctx.root), ...Object.keys(devicesThere(ctx))]), made: true };
}

/**
 * The shapes of old files that are not a section as they are (features.json from[].transform):
 * - tailscale-device: a file of one device's settings ({ host, … }) → { default: <id>, devices: { <id>: { tailscaleName, … } } },
 *   the Tailscale name found for its host, the id the device has there already or a new one.
 * - tailscale-device-field: one key of a file (field) → that device's key (as): the device is the one whose settings
 *   file is hostFrom (its host in the tailnet), else the section's default already there.
 */
type Src = ReturnType<typeof asSource>;
const TRANSFORMS: Record<string, (value: unknown, ctx: TransformCtx, src: Src) => { part: unknown; note?: string } | { why: string }> = {
  'tailscale-device': (value, ctx) => {
    if (!isObject(value)) return { part: value };
    if (typeof value.host !== 'string' || !value.host) return { why: '기기 설정에 host가 없음' };
    const d = deviceName(value.host, ctx);
    if (!d.name) return { why: d.why! };
    const { id, made } = deviceId(d.name, ctx);
    // The pair is no secret (the address and key are not printed); a dry run's new id is made again when it really moves.
    const note = `기기 번호 ${id} = Tailscale 이름 ${d.name}${made ? (ctx.dryRun ? ', 새 번호(보기만: 실제로 옮길 때 다시 만듦)' : ', 새 번호') : ''}`;
    return { part: { default: id, devices: { [id]: { tailscaleName: d.name, ...value } } }, note };
  },
  'tailscale-device-field': (value, ctx, src) => {
    const v = isObject(value) && src.field ? value[src.field] : undefined;
    if (v === undefined || v === '') return { part: undefined };
    let id: string | undefined;
    let why = '어느 기기의 값인지 모름';
    const from = src.hostFrom ? readJson<{ host?: unknown }>(path.join(ctx.root, ...src.hostFrom.split('/'))) : null;
    if (from?.ok && typeof from.value?.host === 'string') {
      const d = deviceName(from.value.host, ctx);
      if (d.name) {
        id = idThere(d.name, ctx);
        if (!id) why = `기기 ${d.name}이 아직 설정에 없음(그 기기 설정을 먼저 옮긴다)`;
      } else why = d.why!;
    } else {
      const there = ctx.now.shared[ctx.section] ?? ctx.now.secretary[ctx.section];
      if (isObject(there) && typeof there.default === 'string') id = there.default;
    }
    return id ? { part: { devices: { [id]: { [src.as ?? src.field!]: v } } } } : { why };
  },
};

/** The thisSecretary columns of a feature list (every feature, on or off: a file of a feature turned off still keeps its values). */
export function thisSecretaryColumns(features: Feature[] | null): ThisSecretaryColumn[] {
  return (features ?? []).flatMap((f) => (f.thisSecretary ? [f.thisSecretary] : []));
}

export interface MergeOptions {
  dryRun?: boolean;
  /** The columns to follow (default this copy's features.json; an update passes the new version's). */
  features?: Feature[] | null;
  now?: Date;
  /** `tailscale status --json` output (tests); default runs tailscale (never under the test mark). */
  tailscaleStatus?: () => string | null;
}

/**
 * What the merge would do in `root`: each separate file and its parts, and the sections each file would get (`write`:
 * the whole new value of each touched section).
 */
export function planThisSecretaryMerge(root = PROJECT_ROOT, opts: MergeOptions = {}): { items: MergeItem[]; write: Record<Place, Sections>; error: string | null } {
  const features = opts.features === undefined ? readFeatures(root) : opts.features;
  const write: Record<Place, Sections> = { secretary: {}, shared: {} };
  if (shielded('secretary', root)) return { items: [], write, error: null };
  const now = {} as Record<Place, Sections>;
  for (const place of ['secretary', 'shared'] as Place[]) {
    const all = readAll(place, root);
    if (!all.ok) return { items: [], write, error: `${nameOf(place)}을 못 읽음: ${all.error}` };
    now[place] = { ...all.value };
  }
  let devices: TailscaleDevice[] | null | undefined;
  const ctx: Omit<TransformCtx, 'section'> = {
    root,
    dryRun: !!opts.dryRun,
    now,
    devices: () => {
      if (devices === undefined) {
        const text = (opts.tailscaleStatus ?? (() => readTailscaleStatus()))();
        devices = text ? parseTailscaleStatus(text) : null;
      }
      return devices;
    },
  };
  // Each separate file once, with the sections it feeds (one file may feed two: mistake-guards.local.json).
  const byFile = new Map<string, { section: string; place: Place; src: ReturnType<typeof asSource> }[]>();
  for (const col of thisSecretaryColumns(features)) {
    for (const s of (col.from ?? []).map(asSource)) byFile.set(s.file, [...(byFile.get(s.file) ?? []), { section: col.section, place: placeOf(col), src: s }]);
  }
  const items: MergeItem[] = [];
  for (const [file, uses] of byFile) {
    const full = path.join(root, ...file.split('/'));
    if (!fs.existsSync(full)) continue;
    const r = readJson<unknown>(full);
    if (!r.ok) {
      items.push({ file, parts: [], error: r.error, done: false });
      continue;
    }
    // A file is taken whole or not at all: a part that differs from what is there (or cannot be placed) keeps all of it in the file.
    const parts = uses.map(({ section, place, src }) => {
      let part = partOf(r.value, src);
      let note: string | undefined;
      if (src.transform) {
        const t = TRANSFORMS[src.transform];
        if (!t) return { section, place, state: 'unresolved' as State, why: `모르는 transform ${src.transform}` };
        const out = t(part, { ...ctx, section }, src);
        if ('why' in out) return { section, place, state: 'unresolved' as State, why: out.why };
        part = out.part;
        note = out.note;
      }
      if (isEmpty(part)) return { section, place, state: 'empty' as State };
      const m = mergeInto(now[place][section], part);
      return { section, place, state: m.state as State, value: m.value, ...(note ? { note } : {}) };
    });
    const done = parts.every((p) => p.state !== 'differs' && p.state !== 'unresolved');
    if (done) {
      for (const p of parts) {
        if (p.state !== 'add') continue;
        now[p.place][p.section] = (p as { value: unknown }).value;
        write[p.place][p.section] = now[p.place][p.section];
      }
    }
    items.push({ file, parts: parts.map((p) => ({ section: p.section, place: p.place, state: !done && p.state === 'add' ? 'held' : p.state, ...(p.why ? { why: p.why } : {}), ...(done && 'note' in p && p.note ? { note: p.note } : {}) })), done });
  }
  return { items, write, error: null };
}

const STATE_TEXT: Record<State, string> = {
  add: '옮김',
  same: '이미 같은 값',
  differs: '이미 다른 값이 있어 그대로 둠',
  empty: '옮길 값 없음',
  held: '같은 파일의 다른 키 때문에 옮기지 않음',
  unresolved: '옮기지 못해 그대로 둠',
};

/**
 * Merges the separate files into this secretary's file and the PC's shared one (dryRun: only says what it would do). A file
 * goes to backups/this-secretary-merge/<time>/<its path> once all of it is in; a file with a part that differs from what is
 * already there, that cannot be placed, or that is not JSON stays as it is (the lines say so). Values are never printed,
 * only file and section names. Returns the lines and the files left.
 */
export function mergeThisSecretaryFiles(root = PROJECT_ROOT, opts: MergeOptions = {}): { lines: string[]; left: string[] } {
  const { dryRun = false, now = new Date() } = opts;
  const plan = planThisSecretaryMerge(root, opts);
  const lines: string[] = [];
  if (plan.error) return { lines: [`${plan.error} — 이 파일을 먼저 고친다(옮기기는 아무것도 하지 않음)`], left: plan.items.map((i) => i.file) };
  const pre = dryRun ? '(보기만) ' : '';
  if (!plan.items.length) return { lines: [`${pre}옮길 옛 이 비서 설정 파일 없음`], left: [] };
  if (!dryRun) for (const place of ['secretary', 'shared'] as Place[]) if (Object.keys(plan.write[place]).length) writeSections(place, root, plan.write[place]);
  const digits = formatLocal(now.getTime(), false, true).replace(/\D/g, '');
  const stamp = `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
  const left: string[] = [];
  for (const it of plan.items) {
    const parts = it.parts.map((p) => `${nameOf(p.place)}의 '${p.section}' 키 ${STATE_TEXT[p.state]}${p.why ? `: ${p.why}` : ''}${p.note ? ` (${p.note})` : ''}`).join(', ');
    if (it.error) {
      lines.push(`${pre}그대로 둠: ${it.file} (JSON으로 못 읽음: ${it.error.slice(0, 80)})`);
      left.push(it.file);
    } else if (!it.done) {
      lines.push(`${pre}그대로 둠: ${it.file} → ${parts} — 정한 뒤 옛 파일을 옮기거나 지운다(이 명령은 있는 값을 덮어쓰지 않는다)`);
      left.push(it.file);
    } else {
      const to = `${MERGE_BACKUP_DIR}/${stamp}/${it.file}`;
      if (!dryRun) moveAside(path.join(root, ...it.file.split('/')), path.join(root, ...to.split('/')));
      lines.push(`${pre}${it.file} → ${parts}, 옛 파일은 ${to}`);
    }
  }
  return { lines, left };
}

/** Moves a file (a copy then a delete across drives), never over another one (a number is put before the extension). */
function moveAside(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let target = to;
  for (let n = 2; fs.existsSync(target); n++) target = to.replace(/(\.[^./\\]+)?$/, `-${n}$1`);
  try {
    fs.renameSync(from, target);
  } catch {
    fs.copyFileSync(from, target);
    fs.rmSync(from);
  }
}

/** The separate files still there (none merged yet, or left because a value differs or it is not JSON): for the install check. */
export function leftoverThisSecretaryFiles(root = PROJECT_ROOT, features: Feature[] | null = readFeatures(root)): string[] {
  if (shielded('secretary', root)) return [];
  const files = new Set(thisSecretaryColumns(features).flatMap((c) => (c.from ?? []).map((s) => asSource(s).file)));
  return [...files].filter((f) => fs.existsSync(path.join(root, ...f.split('/'))));
}
