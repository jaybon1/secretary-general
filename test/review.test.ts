import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { continuityContext } from '../src/session-continuity/situation-board-notice.ts';
import { reviewNote } from '../src/mcp/delegate-tools.ts';
import { SCHEMA_VERSION } from '../src/store/schema.ts';
import { REVIEW_REMIND_DAYS, staleReviewLines } from '../src/workspace/review-check.ts';
import { renderTaskBrief } from '../src/workspace/rules-text.ts';
import { tempDir, tempStore, testDb, testStore } from './helpers.ts';

const DAY = 86_400_000;

test('migration 13: tasks keep their rows and ids, and take the review status with its two fields; a backup is made first', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secretary.db');
  const old = testStore(file, 12);
  const ws = old.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const now = new Date().toISOString();
  old.db.prepare("INSERT INTO tasks (id, workspace_id, name, title, goal, output_dir, status, session_ref, result, created_at, updated_at) VALUES (7, ?, 'a', 'A', 'g', 'o1', 'done', 'bg:1', '끝', ?, ?)").run(ws.id, now, now);
  old.db.prepare("INSERT INTO tasks (id, workspace_id, name, title, goal, output_dir, status, created_at, updated_at) VALUES (9, ?, 'b', 'B', 'g', 'o2', 'running', ?, ?)").run(ws.id, now, now);
  assert.throws(() => old.db.prepare("UPDATE tasks SET status = 'review' WHERE id = 9").run(), /CHECK constraint/);
  old.db.close();

  const db = testDb(file);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const rows = db.prepare('SELECT id, status, session_ref, result, review_needed, review_since FROM tasks ORDER BY id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 7, status: 'done', session_ref: 'bg:1', result: '끝', review_needed: 0, review_since: null },
    { id: 9, status: 'running', session_ref: null, result: null, review_needed: 0, review_since: null },
  ]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tasks_workspace'").get());
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = 9").run();
  db.close();
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1, 'the old DB is copied before the rebuild');
});

test('a task planned for review: it waits in review from the day it went there, and is asked about again after three days', () => {
  const s = tempStore();
  const ws = s.createWorkspace({ kind: 'solo', name: 'video', title: '영상', purpose: '영상 제작', folder: 'C:/ws/video', agents: [] });
  const t = s.createTask({ workspaceId: ws.id, name: 'cut', title: '쇼츠 편집', goal: 'g', outputDir: 'o', review: true });
  assert.equal(t.review_needed, 1);
  assert.equal(t.review_since, null);
  const plain = s.createTask({ workspaceId: ws.id, name: 'memo', title: '조사', goal: 'g', outputDir: 'o2' });
  assert.equal(plain.review_needed, 0);

  const inReview = s.updateTask(t.id, { status: 'review', result: '보고 확인함' })!;
  assert.equal(inReview.status, 'review');
  assert.ok(inReview.review_since);
  // A later change in review keeps the day it started waiting.
  s.db.prepare('UPDATE tasks SET review_since = ? WHERE id = ?').run(new Date(Date.now() - (REVIEW_REMIND_DAYS + 1) * DAY).toISOString(), t.id);
  const since = s.getTask(t.id)!.review_since;
  s.updateTask(t.id, { status: 'review', result: '고친 요약' });
  assert.equal(s.getTask(t.id)!.review_since, since);
  assert.deepEqual(s.listTasks({ status: 'review' }).map((x) => x.id), [t.id]);

  const lines = staleReviewLines(s);
  assert.equal(lines.length, 3);
  assert.match(lines[1], new RegExp(`^- 업무 ${t.id} "쇼츠 편집" · .*부터 4일 · `));
  assert.match(lines[2], /update_task done/);
  // Not yet three days: nothing to ask.
  assert.deepEqual(staleReviewLines(s, Date.now() - 2 * DAY), []);
  // A new session is told even with no previous session or questions.
  assert.match(continuityContext(s, 'new'), /<secretary-continuity>[\s\S]*검수 대기 3일 넘은 업무[\s\S]*쇼츠 편집/);

  s.updateTask(t.id, { status: 'done' });
  assert.deepEqual(staleReviewLines(s), []);
  assert.equal(continuityContext(s, 'new'), '');
  // The review flag can be set later (an approved change of plan).
  assert.equal(s.updateTask(plain.id, { review: true })!.review_needed, 1);
});

test('update_task notes: into review asks the user; done before the user looked is pointed out', () => {
  const s = tempStore();
  const ws = s.createWorkspace({ kind: 'solo', name: 'web', title: '웹', purpose: '웹', folder: 'C:/ws/web', agents: [] });
  const t = s.createTask({ workspaceId: ws.id, name: 'page', title: '소개 페이지', goal: 'g', outputDir: 'o', review: true });
  assert.match(reviewNote('review', undefined)!, /done, "아직"이면 그 말을 피드백으로 새 업무에 넘긴다/);
  assert.match(reviewNote('done', s.getTask(t.id))!, /검수 대기: 예/);
  s.updateTask(t.id, { status: 'review' });
  assert.equal(reviewNote('done', s.getTask(t.id)), null, 'done after review is the normal end');
  assert.equal(reviewNote('running', s.getTask(t.id)), null);
});

test('the brief says what a review task leaves for the user to look at', () => {
  const brief = renderTaskBrief({ name: 'cut', title: '쇼츠 편집', goal: 'g', doneCriteria: ['c'], proof: ['p'], review: true });
  assert.match(brief, /## 진행 방식[\s\S]*- 검수 대기: 예 \(사용자가 결과물을 직접 보고 확인해야 끝난다/);
  assert.doesNotMatch(renderTaskBrief({ name: 'x', title: 'x', goal: 'g', doneCriteria: ['c'], proof: ['p'] }), /검수 대기/);
});
