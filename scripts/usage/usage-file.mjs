// 사용량 기록 파일의 위치. 공급자·계정마다 ~/.secretary/usage/subscription-<계정>.json 하나씩 둔다(계정을 못 읽거나 계정이 없는 공급자는 <공급자>.json).
// 2026-11-09까지는 ~/.claude/usage였고, 그곳에 쓰는 옛 사본이 남아 있는 동안 readUsage·readOverrideUntil이 두 곳을 다 읽어 새것을 쓴다.
// 공급자 이름은 providers.ps1의 Use-Provider가 SECRETARY_PROVIDER로 넘긴다. 없으면 이 PC 기본 로그인(subscription).
// 규칙은 src/usage/usage-files.ts 한 곳에 있고(프롬프트 훅도 같은 것을 쓴다), 여기서는 상태줄·정지 훅용 이름으로 내보낸다.
export { USAGE_DIR as usageDir, overrideFile, readOverrideUntil, readUsage, refreshFile, failureWait, currentProvider, onSubscription, usageFile, dropLegacyUsageFiles, guardOff } from '../../src/usage/usage-files.ts';
