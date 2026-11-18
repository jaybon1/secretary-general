import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { updateOpenQuestions } from '../src/store/open-questions.ts';
import { buildSummary, renderSummary } from '../src/todo-summary/todo-summary.ts';
import { recall } from '../src/memory/recall.ts';
import { CALENDAR_META } from '../src/todo-summary/calendar.ts';
import type { ActionInput, Store } from '../src/store/store.ts';
import { say, tempDir, tempStore } from './helpers.ts';

/** 2026-11-14 12:00 in Korea. */
const NOW = Date.parse('2026-11-14T03:00:00Z');

function action(s: Store, content: string, values?: Omit<ActionInput, 'by'>): number {
  const { id } = s.remember({ kind: 'action', content });
  if (values) s.setAction(id, { ...values, by: 'test' });
  return id;
}

function task(s: Store, title: string, status: 'ready' | 'running' | 'asking' | 'done') {
  const ws = s.quickWorkspace() ?? s.createWorkspace({ kind: 'quick', name: 'quick', title: '간단', purpose: 'p', folder: path.join(tempDir(), 'q'), agents: [] });
  const t = s.createTask({ workspaceId: ws.id, name: `t${Math.random()}`, title, goal: 'g', outputDir: `o${Math.random()}` });
  if (status !== 'ready') s.updateTask(t.id, { status });
  return t;
}

const event = (start: string, title: string, over: { all_day?: boolean; location?: string } = {}) => ({ uid: title, recurrence_at: start, start_at: start, end_at: null, all_day: over.all_day ?? false, title, location: over.location ?? null });

// 없으면 놓치는 실수: 할 일 요약이 DB 밖(상황판)에서 읽거나, 사용자 할 일을 기한·조건으로 잘못 나누거나, 비서 할 일·값 없는 할 일·닫힌 할 일·7일 밖
// 일정을 사용자에게 보여 주거나, 오늘 이미 지난 일정을 빼거나, 일정 받기가 실패했는데 몇 시 기준인지 말하지 않는다(2026-11-14 사용자 결정).
// 남은 질문을 18자로 잘라 뜻을 잃거나(답 끝 단계의 짧은 이름이 있으면 그 이름, 없으면 물음표로 끝나는 질문 문장 전체), [질문]으로 멈춘 업무를 진행 중으로 보인다.
test('the summary: open questions, running tasks, the user\'s agenda lines, the user\'s actions by due date and condition, today\'s and the next 7 days\' events', () => {
  const s = tempStore();
  assert.equal(renderSummary(buildSummary(s, NOW)), '할 일 요약: 없음');
  say(s, 'q', 'assistant', 'A. 알림은 몇 시에 보낼까요?\n1. 9시\n2. 기타 (직접 입력)\n\nB. 지금은 같은 알림이 폰에 두 번 와요. 아침 알림과 저녁 알림을 하나로 합쳐서 보낼까요?\n1. 합친다\n2. 기타 (직접 입력)\n\n다음 행동 및 순서:\n1. 남은 질문에 답해 주세요: A(알림 시각), B');
  updateOpenQuestions(s, 'q', NOW);
  const running = task(s, '영상 만들기', 'running');
  const asking = task(s, '로고 시안', 'asking');
  task(s, '끝난 일', 'done');
  s.setMainAgenda({ name: '텃밭 정리', state: '사용자 차례', note: '구역 정하기' });
  s.setMainAgenda({ name: '이사 준비', state: '진행 중' });
  action(s, '2026-11-10 화분 흙 사기', { owner: 'user', due: '2026-11-12' });
  action(s, '씨앗 주문하기', { owner: 'user', due: '2026-11-21T15:00+09:00' });
  action(s, '겨울 준비', { owner: 'user', due: '2026-12-30' });
  action(s, '물뿌리개 고르기', { owner: 'user', condition: { kind: 'task_done', value: String(running.id) }, state: 'met' });
  action(s, '비료 주기', { owner: 'user', condition: { kind: 'text', value: '싹이 남' } });
  // 없으면 놓치는 실수: 기한도 조건도 없는 사용자 할 일이 요약 어디에도 없어 사용자가 잊는다(2026-11-18 사용자 결정: '기한 없는 할 일' 칸).
  action(s, '텃밭 구역 그리기', { owner: 'user' });
  action(s, '비서가 일정표를 만든다', { owner: 'secretary', due: '2026-11-15' });
  action(s, '값 없는 옛 할 일');
  s.forget(action(s, '닫힌 할 일', { owner: 'user', due: '2026-11-15' }), '끝남');
  s.replaceCalendarRange('2026-11-12T15:00:00.000Z', '2026-12-15T15:00:00.000Z', [
    event('2026-11-13T05:00:00.000Z', '어제 일'),
    event('2026-11-14T00:00:00.000Z', '아침 회의'),
    event('2026-11-13T15:00:00.000Z', '김장', { all_day: true }),
    event('2026-11-16T06:00:00.000Z', '치과', { location: '강남' }),
    event('2026-11-22T06:00:00.000Z', '8일 뒤 일'),
  ], new Date(NOW).toISOString());
  s.setJson(CALENDAR_META, { at: new Date(NOW).toISOString(), ok: false, error: 'HTTP 500', lastOkAt: '2026-11-14T00:30:00.000Z' });
  const text = renderSummary(buildSummary(s, NOW));
  assert.deepEqual(text.split('\n'), [
    '할 일 요약',
    '- 남은 질문',
    '  - A(알림 시각)',
    '  - B(아침 알림과 저녁 알림을 하나로 합쳐서 보낼까요?)',
    '- 도는 업무',
    `  - 업무${running.id}(영상 만들기) 진행 중`,
    `  - 업무${asking.id}(로고 시안) 질문 대기`,
    '- 사용자 차례 안건',
    '  - 텃밭 정리 — 구역 정하기',
    '- 기한 지난 할 일',
    '  - 화분 흙 사기 (11/12까지)',
    '- 7일 안 기한',
    '  - 씨앗 주문하기 (11/21 15:00까지)',
    '- 조건 채워진 할 일',
    `  - 물뿌리개 고르기 (업무 ${running.id} 끝남)`,
    '- 조건 기다리는 할 일',
    '  - 비료 주기 (조건: 싹이 남)',
    '- 기한 없는 할 일',
    '  - 텃밭 구역 그리기',
    '- 오늘 일정',
    '  - 종일 김장',
    '  - 09:00 아침 회의',
    '- 7일 안 일정',
    '  - 11/16(월) 15:00 치과 (강남)',
    '(일정은 11/14 09시 기준(그 뒤 받기 실패))',
  ]);
});
