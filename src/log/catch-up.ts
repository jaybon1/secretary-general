/**
 * The secretary's own Claude Code transcripts (<config dir>/projects/<this folder>/*.jsonl) across every
 * account: catching up what a Stop hook missed, and when talk last happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { ingestTranscript } from './ingest-transcript.ts';
import { accountConfigDirs } from '../core/provider-accounts.ts';
import type { Store } from '../store/store.ts';

/** Other sessions' transcripts untouched this long are caught up at session start; younger ones may be mid-turn. */
const CATCH_UP_MIN_IDLE_MS = 10 * 60 * 1000;
const CATCH_UP_MAX_AGE_MS = 24 * 3600 * 1000;

/** This project's transcript folders under every account's config dir (a: ~/.claude, b: ~/.claude-b). */
export function transcriptDirs(): string[] {
  const name = PROJECT_ROOT.replace(/[^A-Za-z0-9]/g, '-');
  return accountConfigDirs()
    .map((r) => path.join(r, 'projects', name))
    .filter((d) => fs.existsSync(d));
}

/**
 * SessionStart: log what other sessions' Stop hooks missed, e.g. a turn cut off because the
 * session was archived mid-turn. Transcripts touched in the last few minutes are left alone,
 * unless minIdleMs is 0: server-control does that right after stopping the server, when no
 * session can still be mid-turn (a turn that restarted the server never reaches its Stop hook).
 */
export function catchUpTranscripts(store: Store, currentPath?: string, minIdleMs = CATCH_UP_MIN_IDLE_MS): number {
  let added = 0;
  const now = Date.now();
  for (const dir of transcriptDirs()) {
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (!f.endsWith('.jsonl') || (currentPath && path.resolve(file) === path.resolve(currentPath))) continue;
      // One unreadable file (deleted or locked mid-scan) must not cost the session its profile injection.
      try {
        const age = now - fs.statSync(file).mtimeMs;
        if (age >= minIdleMs && age <= CATCH_UP_MAX_AGE_MS) added += ingestTranscript(store, file).added;
      } catch (err) {
        process.stderr.write(`[secretary] catch-up skipped ${f}: ${(err as Error).message}\n`);
      }
    }
  }
  return added;
}

/**
 * When talk last happened: the newest logged message, or a secretary transcript written since
 * (a long turn is logged only when it ends, but its transcript grows while it runs).
 */
export function lastActivityMs(store: Store, dirs: string[] = transcriptDirs()): number {
  const logged = store.lastLogAt();
  let last = logged ? Date.parse(logged) : 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        last = Math.max(last, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {
        // Deleted mid-scan.
      }
    }
  }
  return last;
}
