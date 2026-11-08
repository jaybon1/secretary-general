import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { findThreat } from '../src/memory/injection-screen.ts';
import { tempDir } from './helpers.ts';

test('scan-threats: a leading BOM is not invisible_unicode, but invisible characters inside the text still are', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bom.md'), '﻿# 제목\n평범한 문장\n');
  fs.writeFileSync(path.join(dir, 'hidden.md'), '# 제목\n평범한​문장\n가운데﻿글자\n');
  fs.writeFileSync(path.join(dir, 'bom-hidden.md'), '﻿# 제목\n평범한​문장\n');
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(PROJECT_ROOT, 'scripts', 'export', 'scan-threats.mjs'), dir], { encoding: 'utf8' });
  const hits = out.trim().split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(hits, ['bom-hidden.md\t2\tinvisible_unicode', 'hidden.md\t2\tinvisible_unicode', 'hidden.md\t3\tinvisible_unicode']);
  // The memory-write screen is unchanged: a BOM anywhere in a memory is still refused.
  assert.equal(findThreat('﻿평범한 문장'), 'invisible_unicode');
});
