// 비서 입구: 비서 폴더 밖에서는 이 고정 이름(입구 폴더 bin의 dashboard.mjs. 입구 폴더는 작업 공간에서는 맨 위 secretary-link.local.json의 bin, 없으면 환경변수 SECRETARY_<번호>_DIR 아래 bin)으로 부른다. 실제 파일: src/dashboard/dashboard.ts
// 스크립트를 옮기면 이 줄과 src/core/paths.ts의 SCRIPTS만 고친다(test/entry-points.test.ts).
export * from '../src/dashboard/dashboard.ts';
