/**
 * 비서 기억을 Claude Code에 내놓는 MCP 서버(stdio). 서버를 만들고 도구 파일(기억 memory-tools, 큰 일 big-work-tools,
 * 위임 delegate-tools, 실수 기록 mistake-tools)의 등록 함수를 부른다. --readonly면 recall·search_log만 등록한다.
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
import { openDb } from '../store/schema.ts';
import { registerBigWorkTools } from './big-work-tools.ts';
import { fail, ok, type ToolContext } from './common.ts';
import { registerDelegateTools } from './delegate-tools.ts';
import { registerLogTools, registerMemoryTools } from './memory-tools.ts';
import { registerMistakeTools } from './mistake-tools.ts';
import { Store } from '../store/store.ts';

/**
 * `--readonly`: memory reading for work sessions and run-jobs on subscription providers.
 * Only recall and search_log are registered, and recalls neither touch memories nor log usage,
 * so nothing outside the secretary's own session writes to the DB through this server. The DB is opened read-only
 * too: never created or migrated from here (the secretary's own server does that). With no DB yet, an empty one in
 * memory answers (nothing found).
 */
const READONLY = process.argv.includes('--readonly');
const READONLY_TOOLS = new Set(['recall', 'search_log']);

function openStore(): Store {
  if (!READONLY) return new Store(openDb());
  if (!fs.existsSync(DB_PATH)) return new Store(openDb(':memory:'));
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return new Store(db);
}

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
const ctx: ToolContext = { server, store, readonly: READONLY };
registerMemoryTools(ctx);
registerBigWorkTools(ctx);
registerLogTools(ctx);
registerDelegateTools(ctx);
registerMistakeTools(ctx);

server.registerTool('stats', { description: '기억 저장소 현황과 최근 7일 주입 토큰량.' }, async () =>
  ok(JSON.stringify(store.stats(), null, 2)),
);

await server.connect(new StdioServerTransport());