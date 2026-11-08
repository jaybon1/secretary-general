/**
 * The optional features, listed in features.json at the project root: for each one its files, install
 * check items (setup/check-items.ts), prompt hook notices (hooks/prompt-notices.ts) and scheduled tasks
 * (scripts/tasks/install-tasks.ps1, which reads the same file, names included). A feature with "enabled": false keeps its files
 * but its checks, notices and tasks are skipped. Core features ("core": true) are always on and carry no
 * "enabled". Every check, notice and task belongs to exactly one feature, core or not (test/features.test.ts).
 *
 * No file, or one that does not parse, leaves everything on: the hooks must never break over it. The
 * install check says so (item 'features').
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { readJson, readJsonFile } from '../core/json-file.ts';
import { readInstallId, taskNameWith } from './install-id.ts';

export const FEATURES_FILE = 'features.json';

export interface Feature {
  id: string;
  description: string;
  /** Always on; such an entry has no `enabled`. */
  core?: boolean;
  enabled?: boolean;
  /** Only matters on the original's PC (main PC, its own keys and helpers): its install check items say "원본 전용". */
  originalOnly?: boolean;
  /** Paths relative to the project root; a folder ends with '/'. */
  files: string[];
  /** Install check ids (setup/check-items.ts). */
  checks: string[];
  /** Prompt hook notice names (hooks/prompt-notices.ts). */
  notices: string[];
  /** Its Windows scheduled tasks: the scripts/tasks/install-tasks.ps1 -Task id and the name the task is registered under (with the install id after it). */
  tasks: ScheduledTask[];
  /** Where AGENTS.md has this feature's rules: text found there as is. */
  rules: string[];
}

export interface ScheduledTask {
  id: string;
  name: string;
}

export type FeatureItem = 'checks' | 'notices' | 'tasks';

/** The names of one kind a feature owns (for tasks, their ids). */
export const itemNames = (f: Feature, kind: FeatureItem): string[] =>
  kind === 'tasks' ? (f.tasks ?? []).map((t) => t.id) : (f[kind] ?? []);

export const featuresPath = (root = PROJECT_ROOT) => path.join(root, FEATURES_FILE);

/** The listed features; null when the file is missing or unreadable (then everything is on). */
export function readFeatures(root = PROJECT_ROOT): Feature[] | null {
  const list = readJsonFile<{ features?: Feature[] }>(featuresPath(root))?.features;
  return Array.isArray(list) ? list : null;
}

/** Install check ids of the original-only features; none without the file (then every item counts as common). */
export function originalOnlyChecks(root = PROJECT_ROOT): Set<string> {
  return new Set((readFeatures(root) ?? []).filter((f) => f.originalOnly === true).flatMap((f) => f.checks ?? []));
}

/** Why the list can't be used (for the install check item 'features'); null when it reads fine. */
export function featuresProblem(root = PROJECT_ROOT): string | null {
  const r = readJson<{ features?: unknown }>(featuresPath(root));
  if (!r.ok) return r.missing ? `${FEATURES_FILE} 없음` : `${FEATURES_FILE}을 못 읽음(${r.error.slice(0, 80)})`;
  return Array.isArray(r.value?.features) ? null : `${FEATURES_FILE}에 features 목록이 없음`;
}

export const featureOn = (f: Feature) => f.core === true || f.enabled !== false;

/** The features turned off that own install check items, with those items (left out of the check). */
export function offFeatureChecks(root = PROJECT_ROOT): { id: string; checks: string[] }[] {
  return (readFeatures(root) ?? []).filter((f) => !featureOn(f) && (f.checks ?? []).length).map((f) => ({ id: f.id, checks: f.checks }));
}

/** Names of one kind that belong to a feature turned off. Anything not listed stays on. */
export function disabledItems(kind: FeatureItem, root = PROJECT_ROOT): Set<string> {
  return new Set((readFeatures(root) ?? []).filter((f) => !featureOn(f)).flatMap((f) => itemNames(f, kind)));
}

/**
 * Scheduled task id → its name in features.json, without the install id: the name tasks were registered under before
 * the id (an old name to move from); empty without the file.
 */
export function baseTaskNames(root = PROJECT_ROOT): Record<string, string> {
  return Object.fromEntries((readFeatures(root) ?? []).flatMap((f) => f.tasks ?? []).map((t) => [t.id, t.name]));
}

/**
 * Scheduled task id → the name it is registered under: the features.json name with root's install id, e.g.
 * 'Secretary Idle Jobs (A3F9)' (setup/install-id.ts; the name alone while root has no id yet). Empty without the file
 * (the install check then can't look the tasks up).
 */
export function scheduledTaskNames(root = PROJECT_ROOT, id: string | null = readInstallId(root)): Record<string, string> {
  return Object.fromEntries(Object.entries(baseTaskNames(root)).map(([k, name]) => [k, taskNameWith(name, id)]));
}
