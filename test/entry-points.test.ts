import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { ENTRY_DIR, ENTRY_POINTS, entryPath, entryText, scriptPath, SCRIPTS, type EntryName } from '../src/core/paths.ts';

const names = Object.keys(ENTRY_POINTS) as EntryName[];
const BOM = '\uFEFF';
const read = (file: string) => fs.readFileSync(file, 'utf8');

test('bin/ holds exactly the entry points, each as entryText says, running a script that is there', () => {
  const files = fs.readdirSync(path.join(PROJECT_ROOT, ENTRY_DIR)).sort();
  assert.deepEqual(files, [...names].sort());
  for (const name of names) {
    const text = read(entryPath(name));
    // Windows PowerShell 5.1 reads a .ps1 without a BOM in the ANSI code page (the Korean comments would break).
    assert.equal(text.startsWith(BOM), name.endsWith('.ps1'), `${name}: BOM only on .ps1`);
    assert.equal(text.replace(BOM, '').replace(/\r\n/g, '\n'), entryText(name), `${ENTRY_DIR}/${name} should be:\n${entryText(name)}`);
    assert.ok(fs.existsSync(scriptPath(ENTRY_POINTS[name])), `${name} → ${SCRIPTS[ENTRY_POINTS[name]]} missing`);
  }
});
