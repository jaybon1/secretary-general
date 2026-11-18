/** Reading a JSON file (PowerShell writes some with a BOM), and adding a line to a record file (JSON Lines). */
import fs from 'node:fs';
import path from 'node:path';

export type JsonRead<T> = { ok: true; value: T } | { ok: false; missing: boolean; error: string };

/** A JSON file's value (a leading BOM, as PowerShell writes it, is ignored), or why it could not be read (first line of the error). */
export function readJson<T>(file: string): JsonRead<T> {
  try {
    return { ok: true, value: parseJsonText<T>(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, missing: e.code === 'ENOENT', error: String(e.message ?? e).split('\n')[0] };
  }
}

/** JSON text's value, a leading BOM ignored (Windows PowerShell's Set-Content and Out-File -Encoding utf8 write one). */
export function parseJsonText<T>(text: string): T {
  return JSON.parse(text.replace(/^﻿/, '')) as T;
}

/** A JSON file's value, a leading BOM ignored; throws when it is missing or not JSON (for files that must be there). */
export function readJsonStrict<T>(file: string): T {
  return parseJsonText<T>(fs.readFileSync(file, 'utf8'));
}

/** A JSON file's value; null if missing or unreadable. */
export function readJsonFile<T>(file: string): T | null {
  const r = readJson<T>(file);
  return r.ok ? r.value : null;
}

/** A record file (JSON Lines) grows to about this size before its oldest lines are cut. */
export const JSONL_MAX_BYTES = 1024 * 1024;
/** What a cut keeps: about this many last lines. */
export const JSONL_KEEP_LINES = 2000;

/**
 * One line added to a record file (JSON Lines: one JSON value per line), its folder made when missing. A file past
 * maxBytes keeps only its last keepLines lines first (a reader that keeps byte places in the file passes Infinity).
 * Throws when the line can't be written (callers that must cost their hook nothing catch it).
 */
export function appendJsonLine(file: string, value: unknown, opts: { maxBytes?: number; keepLines?: number } = {}): void {
  const maxBytes = opts.maxBytes ?? JSONL_MAX_BYTES;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > maxBytes) {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-(opts.keepLines ?? JSONL_KEEP_LINES));
      fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
    }
  } catch {
    // No file yet, or a cut that failed: the line is still added.
  }
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}
