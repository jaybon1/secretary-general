/**
 * Archives Claude Code transcripts (JSONL) into raw_log. Runs from the Stop hook,
 * so the conversation is recorded without the model spending any tokens on it. Branches abandoned
 * by a rewind are removed right after each read (log/rewind.ts).
 */
import fs from 'node:fs';
import { cleanRewound } from './rewind.ts';
import type { Store } from '../store/store.ts';
import { parseTranscriptLine, placeQueued, selectEntries, type AnswerOverride } from './transcript-entries.ts';

const OFFSET_PREFIX = 'ingest_offset:';

/** Forgets the read position of transcripts that no longer exist (Claude Code deletes old ones). Returns how many. */
export function pruneIngestOffsets(store: Store): number {
  let n = 0;
  for (const { key } of store.metaWithPrefix(OFFSET_PREFIX)) {
    if (!fs.existsSync(key.slice(OFFSET_PREFIX.length))) {
      store.deleteMeta(key);
      n++;
    }
  }
  return n;
}

/**
 * Ingests new lines since the last call for this transcript. The byte offset is
 * kept in meta, and only complete lines are consumed, so a transcript being
 * written concurrently is safe. Re-ingesting is harmless (message_uuid is unique).
 */
export function ingestTranscript(store: Store, transcriptPath: string, answer?: AnswerOverride): { added: number; offset: number } {
  const key = OFFSET_PREFIX + transcriptPath;
  let offset = Number(store.getMeta(key) ?? 0);
  const size = fs.statSync(transcriptPath).size;
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return { added: 0, offset };

  const fd = fs.openSync(transcriptPath, 'r');
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - offset);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { added: 0, offset };
  const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');

  // The Stop hook runs at the end of a turn, so a chunk holds whole turns.
  const entries = selectEntries(placeQueued(complete.split('\n').filter(Boolean).flatMap(parseTranscriptLine)), answer);
  const added = store.appendLog(entries);
  const newOffset = offset + lastNewline + 1;
  store.setMeta(key, String(newOffset));
  cleanRewound(store, transcriptPath);
  return { added, offset: newOffset };
}
