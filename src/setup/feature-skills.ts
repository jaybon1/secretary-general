/**
 * Where the skill of an optional feature lives (features.json: a feature's files under .agents/skills/<name>/): in
 * .agents/skills/<name>/ while the feature is on, and in .agents/skills-off/<name>/ while it is off, where no CLI looks
 * for skills (Claude Code, Codex and Antigravity read .agents/skills only), so the model never calls it meanwhile
 * (2026-11-09; before, a release put disable-model-invocation in its front matter).
 *
 * The folder moves whole, files and all, so what the user changed in the skill (or added next to it) goes with it both
 * ways. The release ships an off feature's skill in .agents/skills-off/ (scripts/release-build/release-build.mjs build); turning a feature
 * on or off (the features skill) is followed by `node src/cli.ts skill-links`, which moves it (install check 'skills'
 * lists a skill in the wrong place). Both places taken: nothing moves, the user is asked. An update (scripts/update.mjs)
 * reads and writes a release file of such a skill at the place the user's own features.json gives it.
 *
 * Kept free of the rest of src/ (only node: imports and skill-links.ts): the update script runs it from the received
 * repository against the user's folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from './skill-links.ts';

export const OFF_SKILLS_DIR = '.agents/skills-off';

interface FeatureEntry {
  id: string;
  core?: boolean;
  enabled?: boolean;
  files?: string[];
}

/** The skills of the optional features, each with whether its feature is on; none without a readable features.json (all on). */
export function featureSkills(root: string): { name: string; feature: string; on: boolean }[] {
  let list: FeatureEntry[];
  try {
    list = JSON.parse(fs.readFileSync(path.join(root, 'features.json'), 'utf8').replace(/^﻿/, '')).features;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && f.core !== true)
    .flatMap((f) =>
      (f.files ?? [])
        .filter((p) => p.startsWith(`${SKILLS_DIR}/`))
        .map((p) => ({ name: p.slice(SKILLS_DIR.length + 1).split('/')[0], feature: f.id, on: f.enabled !== false })),
    );
}

/** The place a feature's skill folder belongs (relative, forward slashes). */
export const skillPlace = (name: string, on: boolean) => `${on ? SKILLS_DIR : OFF_SKILLS_DIR}/${name}`;

export interface FeatureSkillPlan {
  /** Folders to move to their place. */
  move: { name: string; feature: string; from: string; to: string }[];
  /** Both places have the folder: left for the user. */
  both: { name: string; feature: string; at: string; other: string }[];
}

export function planFeatureSkills(root: string): FeatureSkillPlan {
  const plan: FeatureSkillPlan = { move: [], both: [] };
  for (const s of featureSkills(root)) {
    const to = skillPlace(s.name, s.on);
    const from = skillPlace(s.name, !s.on);
    const has = (rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));
    if (!has(from)) continue;
    if (has(to)) plan.both.push({ name: s.name, feature: s.feature, at: to, other: from });
    else plan.move.push({ name: s.name, feature: s.feature, from, to });
  }
  return plan;
}

/** Moves each folder to its place (dry run: only plans). Returns the plan and what failed (a folder in use). */
export function fixFeatureSkills(root: string, dryRun = false): { plan: FeatureSkillPlan; failed: string[] } {
  const plan = planFeatureSkills(root);
  const failed: string[] = [];
  if (dryRun) return { plan, failed };
  for (const m of plan.move) {
    try {
      fs.mkdirSync(path.dirname(path.join(root, ...m.to.split('/'))), { recursive: true });
      fs.renameSync(path.join(root, ...m.from.split('/')), path.join(root, ...m.to.split('/')));
    } catch (err) {
      failed.push(`${m.from} → ${m.to}: ${(err as Error).message}`);
    }
  }
  return { plan, failed };
}

/** The plan as lines (install check 'skills', skill-links). */
export function formatFeatureSkills(p: FeatureSkillPlan, done = false): string[] {
  return [
    ...p.move.map((m) => `기능 ${m.feature}이 ${m.to.startsWith(OFF_SKILLS_DIR) ? '꺼져' : '켜져'} 있어 스킬 폴더를 ${done ? '옮김' : '옮길 것'}: ${m.from} → ${m.to}`),
    ...p.both.map((b) => `기능 ${b.feature}의 스킬 폴더가 두 곳에 다 있어 옮기지 않음(${b.at}이 맞는 자리, ${b.other}과 비교해 사용자에게 묻는다)`),
  ];
}

/**
 * For the update: a release path of a feature skill (in either place) and where it is in the user's folder. `target`:
 * where it belongs by the user's features.json; `actual`: where the user has it now (the other place when only that has
 * it, else the target); `logical`: the path under .agents/skills, the same in every version, to line versions up.
 * null for any other path.
 */
export function featureSkillPath(p: string, skills: { name: string; on: boolean }[]): { logical: string; target: string; other: string } | null {
  for (const dir of [SKILLS_DIR, OFF_SKILLS_DIR]) {
    if (!p.startsWith(`${dir}/`)) continue;
    const [name, ...rest] = p.slice(dir.length + 1).split('/');
    const s = skills.find((x) => x.name === name);
    if (!s || !rest.length) return null;
    const tail = rest.join('/');
    return { logical: `${SKILLS_DIR}/${name}/${tail}`, target: `${skillPlace(name, s.on)}/${tail}`, other: `${skillPlace(name, !s.on)}/${tail}` };
  }
  return null;
}
