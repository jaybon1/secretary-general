/**
 * The dashboard (feature 'dashboard'), called through bin/dashboard.mjs:
 *   node bin/dashboard.mjs serve [--parent <PID>] [--port <N>] [--force]   the web server (the secretary server starts it)
 *   node bin/dashboard.mjs status --text | --json                          the "상태" text (works with the server off)
 *   node bin/dashboard.mjs urls                                            the addresses to open
 *
 * serve follows the helper rules of the secretary server (scripts/server/remote-server.ps1): with --parent it ends when
 * that process (the server window) does, it ends quietly when the port is taken (it runs already), it writes no log
 * file. With the feature turned off in features.json it ends at once (--force runs it anyway).
 * Settings: src/dashboard/settings.ts (this PC's own in scripts/dashboard.local.json).
 * Its /settings page chooses whose usage is read and shown (scripts/usage.local.json, usage/usage-settings.ts); the
 * reading itself is the feature usage-poll (usage/usage-poller.ts), which the secretary server starts on its own.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../core/config.ts';
import { keysDir } from '../core/provider-accounts.ts';
import { collect } from './collect.ts';
import { listen } from './server.ts';
import { dashboardOn, dashboardUrls, readSettings } from './settings.ts';
import { Share } from './share.ts';
import { statusText } from './status-text.ts';
import { readUsageChoice, saveUsageChoice, usageSettingsView } from '../usage/usage-settings.ts';
import { readProviders } from '../usage/providers.ts';

export const USAGE = [
  '사용:',
  '  node bin/dashboard.mjs serve [--parent <PID>] [--port <N>] [--force]',
  '  node bin/dashboard.mjs status --text | --json',
  '  node bin/dashboard.mjs urls',
].join('\n');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : (args[i + 1] ?? '');
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const { settings, problem } = readSettings();
  if (cmd === 'status' && (args[0] === '--text' || args[0] === '--json') && args.length === 1) {
    const d = await collect({ recentDone: settings.recentDone, refreshSec: settings.refreshSec });
    console.log(args[0] === '--json' ? JSON.stringify(d, null, 2) : statusText(d));
    return 0;
  }
  if (cmd === 'urls' && !args.length) {
    for (const u of dashboardUrls(settings)) console.log(u);
    if (problem) console.error(`설정 일부 무시: ${problem}`);
    return 0;
  }
  if (cmd !== 'serve') {
    console.error(USAGE);
    return 2;
  }
  if (!dashboardOn() && !args.includes('--force')) return 0;
  const parentArg = flag(args, '--parent');
  const parent = parentArg === undefined ? 0 : Number(parentArg);
  if (parentArg !== undefined && !(parent > 0)) return 2;
  const portArg = flag(args, '--port');
  const port = portArg === undefined ? settings.port : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return 2;
  if (parent) {
    if (!alive(parent)) return 0;
    setInterval(() => {
      if (!alive(parent)) process.exit(0);
    }, 5000);
  }
  if (problem) console.error(`대시보드 설정 일부 무시: ${problem}`);
  const share = new Share({ roots: settings.share, secretaryRoot: PROJECT_ROOT, keysDir: keysDir() });
  // Usage: which providers are read and shown (/settings). The reading is the feature usage-poll's (usage/usage-poller.ts).
  const providers = () => readProviders();
  const usage = {
    view: () => {
      const list = providers();
      return usageSettingsView(list, readUsageChoice(list));
    },
    save: (input: unknown) => saveUsageChoice(input, providers()),
  };
  const l = await listen(
    { refreshSec: settings.refreshSec, share, usage, status: () => collect({ recentDone: settings.recentDone, refreshSec: settings.refreshSec }) },
    settings.hosts,
    port,
    {
      onTaken: () => process.exit(0),
      onError: (host, e) => {
        console.error(`대시보드: ${host}:${port}에서 열지 못함(${e.code ?? e.message})`);
        process.exit(1);
      },
    },
  );
  for (const [host, p] of Object.entries(l.ports)) console.log(`대시보드: http://${host}:${p}/`);
  return -1; // keeps running
}

// Runs as a command (bin/dashboard.mjs or this file); a test importing it only gets the exports.
if (['dashboard.mjs', 'dashboard.ts'].includes(path.basename(process.argv[1] ?? ''))) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (e) => {
      console.error((e as Error).stack ?? e);
      process.exitCode = 1;
    },
  );
}
