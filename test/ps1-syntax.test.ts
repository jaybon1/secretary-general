import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { readFeatures } from '../src/setup/features.ts';
import { RELEASE_FILES, readReleaseFiles } from '../src/setup/release-files.ts';

/** Every .ps1 under bin/ and scripts/, subfolders too (relative, forward slashes). */
function ps1Files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.toLowerCase().endsWith('.ps1')) out.push(rel);
    }
  };
  for (const dir of ['bin', 'scripts']) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out.sort();
}

/**
 * Whether a file is the secretary's own. In a general release: the release's file list (release-files.json, written
 * by the release builder) names it, so a script the user wrote, even inside a listed folder, is not. In a copy someone
 * uses, its problem is then a warning, not a failure (after an update too). Without that list (the original): features.json
 * lists it or a folder it is in; every file under bin/ and scripts/ of the original belongs to a feature
 * (test/features.test.ts), so there they all count. Without either, every file counts.
 */
function shippedBy(root: string): (rel: string) => boolean {
  const release = readReleaseFiles(root);
  if (release) return (rel) => Object.hasOwn(release.files, rel);
  const list = readFeatures(root);
  if (!list) return () => true;
  const paths = list.flatMap((f) => f.files);
  return (rel) => paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

/** 5.1 reads a file without a BOM in the ANSI code page: Korean comments and strings would break. */
function bomProblem(root: string, rel: string): string | null {
  const bytes = fs.readFileSync(path.join(root, rel));
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return !bom && bytes.some((b) => b > 0x7f) ? 'non-ASCII text without a UTF-8 BOM (save it as UTF-8 with BOM)' : null;
}

// One Windows PowerShell 5.1 for all files: its parser, the way the scheduled tasks and scripts run them.
const PARSE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$files = Get-Content -LiteralPath $args[0] -Encoding UTF8
$out = foreach ($f in $files) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
  [pscustomobject]@{ file = [string]$f; errors = @($errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`;

/** PowerShell 5.1 parse errors per file (relative path → errors, files without errors left out). */
function parseErrors(root: string, files: string[]): Map<string, string[]> {
  const list = path.join(tempDir(), 'ps1-files.txt');
  fs.writeFileSync(list, files.map((f) => path.join(root, f)).join('\r\n'), 'utf8');
  const script = path.join(path.dirname(list), 'parse.ps1');
  fs.writeFileSync(script, `﻿${PARSE}`, 'utf8');
  const json = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, list], { encoding: 'utf8' });
  const results = JSON.parse(json) as { file: string; errors: string[] }[];
  assert.equal(results.length, files.length);
  return new Map(results.filter((r) => r.errors.length).map((r) => [path.relative(root, r.file).replace(/\\/g, '/'), r.errors]));
}

/** The BOM and parse problems of every .ps1 under root's bin/ and scripts/: the secretary's own files fail, the user's warn. */
function ps1Problems(root: string): { failures: string[]; warnings: string[] } {
  const files = ps1Files(root);
  const shipped = shippedBy(root);
  const parsed = parseErrors(root, files);
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    const bom = bomProblem(root, f);
    const errors = parsed.get(f);
    const why = [bom, errors && `PowerShell 5.1 parse errors: ${errors.join(' / ')}`].filter(Boolean).join('; ');
    if (why) (shipped(f) ? failures : warnings).push(`${f}: ${why}`);
  }
  return { failures, warnings };
}

test('every .ps1 under bin/ and scripts/ parses in Windows PowerShell 5.1, and one with Korean text has a BOM (a script the user added only warns)', { skip: process.platform !== 'win32' }, (t) => {
  assert.ok(ps1Files(PROJECT_ROOT).length > 10, 'found too few .ps1 files');
  const { failures, warnings } = ps1Problems(PROJECT_ROOT);
  // Shown as an "ℹ" line in the test output.
  for (const w of warnings) t.diagnostic(`경고(비서 파일이 아니라 직접 만든 스크립트라 실패로 치지 않음): ${w}`);
  assert.deepEqual(failures, [], 'the secretary\'s own .ps1 files: BOM or PowerShell 5.1 parse problems');
});

test('a .ps1 no feature lists (the user wrote it) only warns; a listed one with the same problem fails', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const korean = '# 한글 메모\nWrite-Output "안녕"\n';
  fs.mkdirSync(path.join(root, 'scripts', 'remote-server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'listed.ps1'), korean, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'remote-server', 'in-folder.ps1'), korean, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'my-tool.ps1'), korean, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'fine.ps1'), 'Write-Output "ok"\n', 'utf8');
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'x', core: true, files: ['scripts/listed.ps1', 'scripts/remote-server/', 'scripts/fine.ps1'], checks: [], notices: [], tasks: [], rules: [] }] }));
  const { failures, warnings } = ps1Problems(root);
  assert.deepEqual(failures.map((f) => f.split(':')[0]), ['scripts/listed.ps1', 'scripts/remote-server/in-folder.ps1']);
  assert.deepEqual(warnings.map((f) => f.split(':')[0]), ['scripts/my-tool.ps1']);
  // Without features.json every file is the secretary's.
  fs.rmSync(path.join(root, 'features.json'));
  assert.equal(ps1Problems(root).failures.length, 3);
});

test('in a release the file list decides: a script the user put in a listed folder only warns', { skip: process.platform !== 'win32' }, () => {
  const root = tempDir();
  const korean = '# 한글 메모\nWrite-Output "안녕"\n';
  fs.mkdirSync(path.join(root, 'scripts', 'remote-server'), { recursive: true });
  for (const f of ['scripts/remote-server/shipped.ps1', 'scripts/remote-server/mine.ps1']) fs.writeFileSync(path.join(root, f), korean, 'utf8');
  // features.json names the whole folder; the release's list names the one file it shipped.
  fs.writeFileSync(path.join(root, 'features.json'), JSON.stringify({ features: [{ id: 'x', core: true, files: ['scripts/remote-server/'], checks: [], notices: [], tasks: [], rules: [] }] }));
  fs.writeFileSync(path.join(root, RELEASE_FILES), JSON.stringify({ version: 'v8', files: { 'scripts/remote-server/shipped.ps1': 'x', 'features.json': 'y' } }));
  const { failures, warnings } = ps1Problems(root);
  assert.deepEqual(failures.map((f) => f.split(':')[0]), ['scripts/remote-server/shipped.ps1']);
  assert.deepEqual(warnings.map((f) => f.split(':')[0]), ['scripts/remote-server/mine.ps1']);
  // A list that does not read: back to features.json.
  fs.writeFileSync(path.join(root, RELEASE_FILES), '{');
  assert.equal(ps1Problems(root).failures.length, 2);
});
