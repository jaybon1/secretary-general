/**
 * 의미 검색 도우미가 함께 쓰는 이름과 위치: 임베딩 모델, 모델 폴더, DB 옆 도우미 파일(상태·장애·실패 기록·메모리), 상태 파일 읽기.
 * 띄우기·검색(semantic/client.ts), 장애 기록·알림(semantic/outage.ts), 도우미 프로세스(semantic/helper-server.ts)가 여기서 가져다 쓴다.
 */
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT } from '../core/config.ts';
import { readJsonFile } from '../core/json-file.ts';

/** Korean fine-tune of bge-m3 (q8 ONNX build), same size and speed; downloaded into models/ on first start. */
export const EMBED_MODEL = 'jaybon1840/BGE-m3-ko-onnx';
export const MODEL_REPO = process.env.SECRETARY_EMBED_MODEL_REPO ?? EMBED_MODEL;
/** What loadModel reads, relative to the model folder. */
export const MODEL_FILES = ['config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
/** Vectors are keyed by model and by what was embedded, so changing the input re-embeds everything once. */
export const VECTOR_KEY = `${EMBED_MODEL}:content+tags`;
export const MODEL_DIR = process.env.SECRETARY_EMBED_MODEL_DIR ?? path.join(PROJECT_ROOT, 'models');
export const MODEL_PATH = path.join(MODEL_DIR, ...EMBED_MODEL.split('/'));
/** One helper per database, so a test or second copy never talks to the wrong one. */
export const STATE_FILE = `${DB_PATH}.embedder.json`;
export const DOWN_FILE = `${DB_PATH}.embedder-down.json`;
export const FAILURE_LOG = `${DB_PATH}.embedder-failures.log`;
/** The failure log keeps this many last lines. */
export const FAILURE_LOG_LINES = 500;
/** The running helper records its own peak memory here (recordPeak), as what a start needs. */
export const MEMORY_FILE = `${DB_PATH}.embedder-memory.json`;
/**
 * Used until the helper has recorded its own: peak working set of the server-bound helper
 * (model loaded, memories embedded) measured on this PC on 2026-10-27 was 1508 MB.
 */
export const HELPER_NEED_MB = 1500;
export const IDLE_MS = (Number(process.env.SECRETARY_EMBED_IDLE_MIN) || 60) * 60_000;
export const disabled = () => process.env.SECRETARY_EMBED === 'off';

export interface HelperState {
  pid: number;
  /** null while the model is still loading. */
  port: number | null;
  /** The process this helper lives and dies with; absent for an on-demand helper. */
  parent?: number;
}

export const readState = () => readJsonFile<HelperState>(STATE_FILE);
