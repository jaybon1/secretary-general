/**
 * Windows processes: whether one is alive, and one WMI query for a list. The install check (setup/windows-probe.ts)
 * and the watcher check (workspace/watch-check.ts) both list through here; the PowerShell side has Get-WinProcess in
 * scripts/lib/common.ps1.
 */
import { execFileSync } from 'node:child_process';

/** True while the process exists; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WinProcess {
  pid: number;
  ppid: number;
  /** Image name, e.g. powershell.exe. */
  name: string;
  exe: string | null;
  cmd: string | null;
}

/**
 * powershell.exe arguments for one query of Win32_Process (`where` is a WQL condition), printing JSON.
 * [wmisearcher] skips loading the CIM module (~0.5 s less than Get-CimInstance). `brief` leaves out the
 * path and command line (much less output when listing every process).
 */
export function processQueryArgs(where?: string, brief = false): string[] {
  const fields = brief ? 'ProcessId,ParentProcessId,Name' : 'ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine';
  const script = [
    // Paths may hold Korean: UTF-8 out, no BOM.
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
    `$p = @(([wmisearcher]"SELECT ${fields} FROM Win32_Process${where ? ` WHERE ${where}` : ''}").Get() | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine } })`,
    'ConvertTo-Json -InputObject $p -Compress',
  ].join('\n');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** Turns that JSON (one object or an array, maybe after a BOM) into processes; null if it isn't that. */
export function parseProcesses(stdout: string): WinProcess[] | null {
  try {
    const v = JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]') as unknown;
    const list = (Array.isArray(v) ? v : [v]) as Array<Record<string, unknown>>;
    return list.map((p) => ({
      pid: Number(p.pid),
      ppid: Number(p.ppid) || 0,
      name: String(p.name ?? ''),
      exe: typeof p.exe === 'string' ? p.exe : null,
      cmd: typeof p.cmd === 'string' ? p.cmd : null,
    }));
  } catch {
    return null;
  }
}

/** The processes matching `where` (all without it), waiting for the answer; null when the query fails. */
export function listProcessesSync(where?: string, { brief = false, timeoutMs = 20_000 } = {}): WinProcess[] | null {
  try {
    const out = execFileSync('powershell.exe', processQueryArgs(where, brief), {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      // PowerShell's progress records (CLIXML) would otherwise land on the hook's stderr.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseProcesses(out);
  } catch {
    return null;
  }
}
