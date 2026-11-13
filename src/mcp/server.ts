/**
 * 비서 기억을 Claude Code에 내놓는 MCP 서버(stdio). 서버를 만들고 도구 파일(기억 memory-tools, 주요 현안 main-agenda-tools,
 * 위임 delegate-tools, 실수 기록 mistake-tools, 정리 담당 판정 consolidate-tools)의 등록 함수를 부른다. --readonly면 recall·search_log만
 * 등록하고, 정리 담당 판정 도구는 --staff memory-consolidation일 때만 등록한다.
 *
 * MCP server exposing the secretary's memory to Claude Code (stdio transport).
 * Register it via .mcp.json; Claude Code launches it on demand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, PROJECT_ROOT } from '../core/config.ts';
import { moveRenamedLocalFiles } from '../core/local-settings.ts';
import { openDb } from '../store/schema.ts';
import { registerMainAgendaTools } from './main-agenda-tools.ts';
import { fail, ok, type ToolContext } from './tool-common.ts';
import { registerDelegateTools } from './delegate-tools.ts';
import { registerLogTools, registerMemoryTools } from './memory-tools.ts';
import { registerMistakeTools } from './mistake-tools.ts';
import { registerConsolidateTools } from './consolidate-tools.ts';
import { Store } from '../store/store.ts';
import { addToTally } from '../memory/consolidate-tally.ts';
import { CandidateBook, nearbySearch, SEMANTIC_WAIT_MS } from '../memory/consolidate-verdicts.ts';
import { allowServerStart, noteMiss, semanticClient, semanticReady } from '../semantic-search/client.ts';
import { STAFF } from '../core/names.ts';

/**
 * `--readonly`: memory reading for work sessions and run-jobs on subscription providers.
 * Only recall and search_log are registered, and recalls neither touch memories nor log usage,
 * so nothing outside the secretary's own session writes to the DB through this server. The DB is opened read-only
 * too: never created or migrated from here (the secretary's own server does that). With no DB yet, an empty one in
 * memory answers (nothing found).
 */
const READONLY = process.argv.includes('--readonly');
const READONLY_TOOLS = new Set(['recall', 'search_log']);
/**
 * `--staff <name>`: the staff member this server was started for (run-job -Staff, scripts/lib/memory-mcp.ps1). The memory
 * consolidation's server counts its writes for the report (memory/consolidate-tally.ts); the secretary's own has none.
 */
const STAFF_ARG = process.argv.includes('--staff') ? process.argv[process.argv.indexOf('--staff') + 1] : undefined;

function openStore(): Store {
  if (!READONLY) {
    // This PC's files under names changed since move first: a recall here may start the semantic-search server or write its
    // files beside the database, and a new one made before the move would leave the old one behind (core/local-settings.ts).
    moveRenamedLocalFiles(PROJECT_ROOT, DB_PATH);
    return new Store(openDb());
  }
  if (!fs.existsSync(DB_PATH)) return new Store(openDb(':memory:'));
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return new Store(db);
}

// Only the secretary's own memory server starts the semantic-search server again; a run-job's or work session's
// read-only one and a staff member's (the consolidation) wait for it (semantic-search/client.ts allowServerStart).
if (!READONLY && !STAFF_ARG) allowServerStart();

const store = openStore();
const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
const server = new McpServer({ name: 'secretary', version });

/** Every tool answers a thrown error with a failed result carrying its message; --readonly registers only READONLY_TOOLS. */
const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;
server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
  if (READONLY && !READONLY_TOOLS.has(name)) return undefined;
  return register(name, config, async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      return fail((err as Error).message);
    }
  });
}) as typeof server.registerTool;

// The order here is the order of the tool list clients see.
const consolidation = !READONLY && STAFF_ARG === STAFF.memoryConsolidation;
const ctx: ToolContext = {
  server,
  store,
  readonly: READONLY,
  // The close memories wait for the semantic-search server; never answering, the run stops (C9, memory/consolidate-verdicts.ts).
  candidates: consolidation
    ? new CandidateBook(store, nearbySearch((onMiss) => semanticClient(5000, '정리 담당 가까운 기억 찾기', onMiss)), {
        ms: SEMANTIC_WAIT_MS,
        pollMs: 5_000,
        ready: semanticReady,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onStop: (reason) => {
          noteMiss('정리 담당 가까운 기억 찾기', reason);
          try {
            addToTally(store, { halted: [reason] });
          } catch {}
        },
      })
    : undefined,
  // A count that fails to save leaves the write itself standing (a failed answer would have the model write it again).
  tally: consolidation
    ? (part) => {
        try {
          addToTally(store, part);
        } catch {}
      }
    : undefined,
};
registerMemoryTools(ctx);
registerConsolidateTools(ctx);
registerMainAgendaTools(ctx);
registerLogTools(ctx);
registerDelegateTools(ctx);
registerMistakeTools(ctx);

server.registerTool('stats', { description: '기억 저장소 현황과 최근 7일 주입 토큰량.' }, async () =>
  ok(JSON.stringify(store.stats(), null, 2)),
);

await server.connect(new StdioServerTransport());