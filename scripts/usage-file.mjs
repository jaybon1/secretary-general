// 사용량 기록 파일의 위치: ~/.claude/usage/<공급자>.json.
// 공급자 이름은 providers.ps1의 Use-Subscription이 SECRETARY_PROVIDER로 넘긴다. 없으면 이 PC에 로그인된 구독(subscription).
import { homedir } from 'node:os';
import { join } from 'node:path';

export const usageDir = join(homedir(), '.claude', 'usage');
export const currentProvider = () => process.env.SECRETARY_PROVIDER || 'subscription';
export const usageFile = (provider = currentProvider()) => join(usageDir, `${provider.replace(/[^\w.-]/g, '_')}.json`);
