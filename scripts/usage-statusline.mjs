// 상태줄 프로그램: Claude Code가 넘겨주는 5시간·주간 사용량을 기록 파일(usage-file.mjs)에 기록하고,
// 상태줄에 "5h 93% · 초기화 14:00" 같은 한 줄을 보여 준다. usage-guard.mjs가 이 파일을 읽는다.
// 원격·백그라운드 세션에서는 상태줄이 돌지 않으므로, 그쪽 기록은 usage.ps1(/usage 조회)이 채운다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { usageDir, usageFile } from './usage-file.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}

const five = input?.rate_limits?.five_hour;
const week = input?.rate_limits?.seven_day;
const pct = typeof five?.used_percentage === 'number' ? five.used_percentage : null;
const resetsAt = toIso(five?.resets_at);

try {
  mkdirSync(usageDir, { recursive: true });
  if (pct !== null) {
    writeFileSync(usageFile(), JSON.stringify({
      five_hour_pct: pct, resets_at: resetsAt,
      week_pct: typeof week?.used_percentage === 'number' ? week.used_percentage : null, week_resets_at: toIso(week?.resets_at),
      updated_at: new Date().toISOString(), source: 'statusline',
    }));
  }
} catch {}

const kst = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
process.stdout.write(pct === null ? '5h 사용량 정보 없음'
  : `5h ${Math.round(pct)}%${resetsAt ? ` · 초기화 ${kst(resetsAt)}` : ''}`);

function toIso(v) {
  if (v == null) return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
