// 의미 검색 도우미가 다시 살아났는지 지켜본다. AI를 부르지 않는 단순 반복 확인이라 기다리는 동안 토큰이 들지 않는다.
// 비서가 백그라운드 명령으로 띄워 두면, 도우미가 살아나거나 시간이 다 됐을 때만 이 스크립트가 끝나며 비서를 깨운다.
// 확인할 때마다 도우미가 꺼져 있으면(실패했으면) 바로 다시 띄운다. 이미 뜨는 중(모델을 다시 받는 중 포함)이면 또 띄우지 않는다.
// 모델을 다시 받았는데도 실패해 멈춘 상태거나 메모리가 부족해 멈춘 상태면 그렇다고 찍고 바로 끝난다.
// --retry는 사용자가 다시 해 보라고(켜라고) 할 때 그 멈춤을 풀고 지켜본다. 또 메모리가 부족하면 다시 멈춤을 찍는다.
// 실패와 회복은 DB 옆 secretary.db.embedder-failures.log에 한 줄씩 남는다.
//
// 예: node scripts/semantic/watch-embedder.mjs [--retry] [--interval-sec 5] [--max-minutes 240]

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return v > 0 ? v : fallback;
};
const intervalSec = arg('interval-sec', 5);
const maxMinutes = arg('max-minutes', 240);

// node:sqlite의 실험 기능 경고가 출력에 섞여 비서에게 가지 않게 한다.
process.removeAllListeners('warning');
const { ensureHelper, freeMemMb, helperNeedMb, lowMemoryNotice, readDown, retryEmbedder, FAILURE_LOG, STOPPED_NOTE } = await import('../../src/semantic/client.ts');
if (process.argv.includes('--retry')) retryEmbedder();

const deadline = Date.now() + maxMinutes * 60_000;
for (;;) {
  let status = 'loading';
  try {
    ({ status } = ensureHelper());
  } catch {
    // 상태 파일을 잠깐 못 쓴 것: 다음 확인 때 다시 한다.
  }
  if (status === 'ready') {
    console.log('검색 도우미가 살아났어요.');
    process.exit(0);
  }
  if (status === 'off') {
    console.log('종료: 의미 검색이 꺼져 있어요(SECRETARY_EMBED=off).');
    process.exit(0);
  }
  if (status === 'stopped') {
    console.log(`멈춤: 검색 도우미가 모델 파일을 ${STOPPED_NOTE}. 마지막 오류: ${readDown()?.error}. 실패 기록: ${FAILURE_LOG}. 감시를 끝내요.`);
    process.exit(0);
  }
  if (status === 'low-memory') {
    console.log(`멈춤: ${lowMemoryNotice(readDown()?.lowMemory?.needMb ?? helperNeedMb(), freeMemMb())} 켜라고 하면 --retry. 실패 기록: ${FAILURE_LOG}. 감시를 끝내요.`);
    process.exit(0);
  }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
const down = readDown();
const last = down ? ` 연속 ${down.failures}번 실패, 마지막 오류: ${down.error}.` : '';
console.log(`시간 초과: ${maxMinutes}분 동안 검색 도우미가 살아나지 않았어요.${last} 실패 기록: ${FAILURE_LOG}. 감시를 끝내요.`);
