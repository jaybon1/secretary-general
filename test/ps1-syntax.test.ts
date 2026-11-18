import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { PROJECT_ROOT } from '../src/core/config.ts';
import { readFeatures } from '../src/core/features.ts';
import { readReleaseFiles } from '../src/setup/release-files.ts';

/** Every .ps1 under bin/, scripts/ and src/ (src/dashboard/running-jobs.ps1 and the like), subfolders too (relative, forward slashes). */
function ps1Files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.toLowerCase().endsWith('.ps1')) out.push(rel);
    }
  };
  for (const dir of ['bin', 'scripts', 'src']) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out.sort();
}

/**
 * Whether a file is the secretary's own. In a general release: the release's file list (release-files.json, written
 * by the release builder) names it, so a script the user wrote, even inside a listed folder, is not. In a copy someone
 * uses, its problem is then a warning, not a failure (after an update too). Without that list (the original): features.json
 * lists it or a folder it is in; every file under bin/, scripts/ and src/ of the original belongs to a feature
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

/** The BOM and parse problems of every .ps1 under root's bin/, scripts/ and src/: the secretary's own files fail, the user's warn. */
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

// [늘 남김] 없으면 놓치는 실수: PowerShell 5.1에서 구문 오류가 나거나 BOM 없는 한국어 .ps1이 들어가, 예약 작업·훅이 조용히 안 돈다(2026-11-12 늘 남김으로 올림).
test('every .ps1 under bin/, scripts/ and src/ parses in Windows PowerShell 5.1, and one with Korean text has a BOM (a script the user added only warns)', { skip: process.platform !== 'win32' }, (t) => {
  assert.ok(ps1Files(PROJECT_ROOT).length > 10, 'found too few .ps1 files');
  const { failures, warnings } = ps1Problems(PROJECT_ROOT);
  // Shown as an "ℹ" line in the test output.
  for (const w of warnings) t.diagnostic(`경고(비서 파일이 아니라 직접 만든 스크립트라 실패로 치지 않음): ${w}`);
  assert.deepEqual(failures, [], 'the secretary\'s own .ps1 files: BOM or PowerShell 5.1 parse problems');
});
