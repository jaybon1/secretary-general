import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The secretary folder: two up from this file (src/core/). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resolved independently of cwd: MCP servers and hooks may start from anywhere. */
export const DB_PATH = process.env.SECRETARY_DB ?? path.join(PROJECT_ROOT, 'secretary.db');

/**
 * Where delegated work gets its own folders: a `workspaces` folder next to the
 * secretary itself, so a copy of this project placed anywhere keeps its workspaces beside it.
 */
export const WORKSPACE_ROOT = process.env.SECRETARY_WORKSPACE_ROOT ?? path.join(path.dirname(PROJECT_ROOT), 'workspaces');

const intEnv = (name: string, fallback: number) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Token budgets. These are hard caps: whatever the memory store grows to,
 * a single turn never injects more than this.
 */
export const BUDGET = {
  /** Core profile, loaded once per session. */
  profileMax: intEnv('SECRETARY_PROFILE_MAX_TOKENS', 2000),
  /** Memories auto-injected on every user prompt. */
  autoRecall: intEnv('SECRETARY_AUTO_RECALL_TOKENS', 2500),
  /** Default for an explicit `recall` tool call. */
  recall: intEnv('SECRETARY_RECALL_TOKENS', 4000),
  /** Hard ceiling an explicit `recall` call may ask for. */
  recallMax: 8000,
};

/** How many FTS hits to pull before reranking. */
export const CANDIDATE_POOL = 60;

/**
 * Timestamps are stored as UTC ISO strings; this zone is only for display
 * (what the model and the user read), always 24-hour.
 */
export const TIMEZONE = process.env.SECRETARY_TZ ?? 'Asia/Seoul';
