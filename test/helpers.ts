import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';

// Tests never start the semantic helper or download its model; semantic tests inject a fake.
process.env.SECRETARY_EMBED = 'off';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-test-'));
}

export function tempStore(): Store {
  return new Store(openDb(path.join(tempDir(), 'test.db')));
}
