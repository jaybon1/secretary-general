/**
 * A decision memory's quote of the user's own words (2026-11-13 the user's call: "원문의 몇번째 줄의
 * 내용이었으며 … 짧은 문구만 원문에서 발췌해서 기록"). The model gives a short phrase; code checks it stands word for word
 * in a logged user message and counts its line, so the injection and recall show next to the decision what the user
 * actually said (`원문 #1234 3줄: "…"`) instead of the model's retelling.
 *
 * - Where it is looked for: the memory's conversation row when that is a user message, then the user messages before it in
 *   the same session (the newest QUOTE_LOOKBACK of them): a decision is often saved a turn or two after the user said it.
 * - Fragments: "…" or "..." in the quote joins parts that must each stand, in order, in the same message (the user's own
 *   example: "...a3... , ...이렇게 저렇게 하자..."). Runs of whitespace count as one space.
 * - A decision saved during a chat has no row yet (the Stop hook links it to the turn when the turn is logged): its quote
 *   waits as 'pending' and is checked right after the link (run-hook.ts); one that is in no message is 'missing' and the
 *   secretary is told on the next prompt. One saved with its row (the consolidation, remember with source_log_id) is checked
 *   at once and refused when missing, so the model copies it again.
 */
import { nowIso } from '../core/kst-time.ts';
import type { Store } from '../store/store.ts';

/** How many earlier user messages of the session are searched after the memory's own row. */
export const QUOTE_LOOKBACK = 30;
/** A quote longer than this is no "short phrase". */
export const QUOTE_MAX_CHARS = 200;

export interface QuoteRow {
  memory_id: number;
  quote: string;
  status: 'pending' | 'found' | 'missing';
  log_id: number | null;
  line: number | null;
  checked_at: string | null;
}

/** The parts of a quote: split at "…" / "...", each trimmed, empty ones dropped. */
export function quoteParts(quote: string): string[] {
  return quote
    .split(/…|\.{3,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim())
    .filter(Boolean);
}

/**
 * The 1-based line of `text` where the quote's first part starts, when every part stands in order (whitespace runs as one
 * space); null otherwise.
 */
export function quoteLine(text: string, quote: string): number | null {
  const parts = quoteParts(quote);
  if (!parts.length) return null;
  // The text with whitespace runs made one space, and where each kept character was in the original.
  let flat = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!space && flat) {
        flat += ' ';
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    flat += ch;
    at.push(i);
  }
  let from = 0;
  let first = -1;
  for (const p of parts) {
    const k = flat.indexOf(p, from);
    if (k < 0) return null;
    if (first < 0) first = k;
    from = k + p.length;
  }
  return text.slice(0, at[first]).split('\n').length;
}

interface LogRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
}

/** Where a quote stands: the row and line, searching the memory's row (if a user's) and the user rows before it. */
export function findQuote(store: Store, sourceLogId: number, quote: string): { logId: number; line: number } | null {
  const row = store.db.prepare('SELECT id, session_id, role, content FROM raw_log WHERE id = ?').get(sourceLogId) as LogRow | undefined;
  if (!row) return null;
  const rows: LogRow[] = row.role === 'user' ? [row] : [];
  rows.push(
    ...(store.db
      .prepare("SELECT id, session_id, role, content FROM raw_log WHERE session_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT ?")
      .all(row.session_id, sourceLogId, QUOTE_LOOKBACK) as unknown as LogRow[]),
  );
  for (const r of rows) {
    const line = quoteLine(r.content, quote);
    if (line !== null) return { logId: r.id, line };
  }
  return null;
}

/** Why a quote is not taken, or '' when its form is fine (the words are checked apart). */
export function quoteFormProblem(quote: string | undefined): string {
  if (!quote?.trim()) return '결정(decision)에는 quote(사용자 말에서 그 결정을 보여 주는 짧은 구절, 글자 그대로)가 필요하다.';
  if (quote.trim().length > QUOTE_MAX_CHARS) return `quote는 ${QUOTE_MAX_CHARS}자 안의 짧은 구절로 준다(긴 부분은 "…"로 줄인다).`;
  if (!quoteParts(quote).length) return 'quote에 글자가 없다.';
  return '';
}

/** The tool argument's description (remember, propose_memory). */
export const QUOTE_DESCRIBE =
  'decision일 때 꼭 넣는다: 사용자 말에서 그 결정을 보여 주는 짧은 구절을 글자 그대로(200자 안, 사이를 줄이려면 "…"로 잇는다. 예: "…a3… , …이렇게 하자…"). 프로그램이 근거 대화의 사용자 말에 그대로 있는지 확인하고 몇째 줄인지 세어 결정 옆에 보여 준다. 다른 종류에는 넣지 않는다';

export const QUOTE_MISSING = (quote: string, where: string) =>
  `quote "${quote}"가 ${where}의 사용자 말에 글자 그대로 없다. search_log로 그 대화를 열어 사용자 말에서 결정을 보여 주는 구절을 그대로 옮겨 다시 낸다(띄어쓰기 말고는 바꾸지 않는다. 사이를 줄이려면 "…"로 잇는다).`;

export function saveQuote(store: Store, memoryId: number, quote: string, found: { logId: number; line: number } | null | 'pending'): void {
  const pending = found === 'pending';
  store.db
    .prepare(
      `INSERT INTO memory_quotes (memory_id, quote, status, log_id, line, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (memory_id) DO UPDATE SET quote = excluded.quote, status = excluded.status, log_id = excluded.log_id, line = excluded.line, checked_at = excluded.checked_at`,
    )
    .run(memoryId, quote.trim(), pending ? 'pending' : found ? 'found' : 'missing', !pending && found ? found.logId : null, !pending && found ? found.line : null, pending ? null : nowIso());
}

export function quoteOf(store: Store, memoryId: number): QuoteRow | undefined {
  return store.db.prepare('SELECT * FROM memory_quotes WHERE memory_id = ?').get(memoryId) as QuoteRow | undefined;
}

/**
 * After a turn is logged and its memories linked (run-hook.ts): every pending quote whose memory now has a row is checked.
 * Returns the memories whose quote stands in no message (to be told on the next prompt).
 */
export function checkPendingQuotes(store: Store): Array<{ memoryId: number; quote: string }> {
  const rows = store.db
    .prepare(
      `SELECT q.memory_id, q.quote, m.source_log_id FROM memory_quotes q JOIN memories m ON m.id = q.memory_id
       WHERE q.status = 'pending' AND m.source_log_id IS NOT NULL`,
    )
    .all() as Array<{ memory_id: number; quote: string; source_log_id: number }>;
  const missing: Array<{ memoryId: number; quote: string }> = [];
  for (const r of rows) {
    const found = findQuote(store, r.source_log_id, r.quote);
    saveQuote(store, r.memory_id, r.quote, found);
    if (!found) missing.push({ memoryId: r.memory_id, quote: r.quote });
  }
  return missing;
}

/** The line shown under a decision that has a found quote: `원문 #1234 3줄: "…"`; '' otherwise. */
export function quoteNote(store: Store, memoryId: number): string {
  let q: QuoteRow | undefined;
  try {
    q = quoteOf(store, memoryId);
  } catch {
    // A database before migration 18 (a read-only server on an old file): no quotes yet.
    return '';
  }
  if (q?.status !== 'found' || q.log_id === null) return '';
  return `  원문 #${q.log_id} ${q.line}줄: "${q.quote}"`;
}

/** The text told on the next prompt when quotes were not found (stop-guard.ts warnings). */
export function missingQuoteWarning(missing: Array<{ memoryId: number; quote: string }>): string {
  return `결정 기억의 원문 발췌가 근거 대화의 사용자 말에 글자 그대로 없다: ${missing
    .slice(0, 3)
    .map((m) => `#${m.memoryId} "${m.quote.slice(0, 60)}"`)
    .join(', ')}. search_log(memory_id)로 그 대화를 열어 사용자가 실제로 그렇게 정했는지 확인하고, 맞으면 사용자 말 그대로의 구절로 remember(supersedes에 그 번호, quote)를 다시 하고, 사용자 말에 없는 결정이면 forget하거나 note("비서가 ~를 권함")로 고친다.`;
}
