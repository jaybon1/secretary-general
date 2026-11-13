/**
 * 의미 검색 서버가 함께 쓰는 이름과 위치: 임베딩 모델, 모델 폴더, DB 옆 의미 검색 서버 파일(상태·장애·실패 기록·메모리), 상태 파일 읽기.
 * 띄우기·검색(semantic-search/client.ts), 장애 기록·알림(semantic-search/outage.ts), 의미 검색 서버 프로세스(semantic-search/semantic-search-server.ts)가 여기서 가져다 쓴다.
 */
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT } from '../core/config.ts';
import { readJsonFile } from '../core/json-file.ts';

/** Environment names (2026-11-09): SECRETARY_SEMANTIC_SEARCH_*; the old SECRETARY_EMBED_* are still read for a while. */
export const semanticSearchEnv = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[`SECRETARY_SEMANTIC_SEARCH_${name}`] ?? env[`SECRETARY_EMBED_${name}`]; // legacy-name: env-semantic-search

/** Korean fine-tune of bge-m3 (q8 ONNX build), same size and speed; downloaded into models/ on first start. */
export const EMBED_MODEL = 'jaybon1840/BGE-m3-ko-onnx';
export const MODEL_REPO = semanticSearchEnv('MODEL_REPO') ?? EMBED_MODEL;
/** What loadModel reads, relative to the model folder. */
export const MODEL_FILES = ['config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
/** Vectors are keyed by model and by what was embedded, so changing the input re-embeds everything once. */
export const VECTOR_KEY = `${EMBED_MODEL}:content+tags`;
export const MODEL_DIR = semanticSearchEnv('MODEL_DIR') ?? path.join(PROJECT_ROOT, 'models');
export const MODEL_PATH = path.join(MODEL_DIR, ...EMBED_MODEL.split('/'));
/** One server per database, so a test or second copy never talks to the wrong one. */
export const STATE_FILE = `${DB_PATH}.semantic-search-server.json`;
export const DOWN_FILE = `${DB_PATH}.semantic-search-server-down.json`;
export const FAILURE_LOG = `${DB_PATH}.semantic-search-server-failures.log`;
/** The callers' miss streak (misses.ts): from the first search the server did not answer to the next it did. */
export const MISS_STREAK_FILE = `${DB_PATH}.semantic-search-misses.json`;
/** The failure log keeps this many last lines. */
export const FAILURE_LOG_LINES = 500;
/** The running server records its own peak memory here (recordPeak), as what a start needs. */
export const MEMORY_FILE = `${DB_PATH}.semantic-search-server-memory.json`;
/**
 * Used until the server has recorded its own: peak working set of a server bound to the secretary server
 * (model loaded, memories embedded) measured on this PC on 2026-10-27 was 1508 MB.
 */
export const SERVER_NEED_MB = 1500;
export const IDLE_MS = (Number(semanticSearchEnv('IDLE_MIN')) || 60) * 60_000;
/** The env variable that turns semantic search off (value off); the old name SECRETARY_EMBED is still read for a while (2026-11-09). */
export const OFF_ENV = 'SECRETARY_SEMANTIC_SEARCH';
export const OLD_OFF_ENV = 'SECRETARY_EMBED'; // legacy-name: env-semantic-search
export const disabled = (env: NodeJS.ProcessEnv = process.env) => env[OFF_ENV] === 'off' || (env[OFF_ENV] === undefined && env[OLD_OFF_ENV] === 'off');

export interface ServerState {
  pid: number;
  /** null while the model is still loading. */
  port: number | null;
  /** The process this server lives and dies with; absent for an on-demand server. */
  parent?: number;
}

export const readState = () => readJsonFile<ServerState>(STATE_FILE);
