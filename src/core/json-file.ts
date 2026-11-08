/** Reading a JSON file (PowerShell writes some with a BOM). */
import fs from 'node:fs';

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
