/**
 * Prompt-injection / exfiltration screen for text that gets injected into every
 * future prompt (memories, profile). A poisoned memory would persist across
 * sessions, so a match blocks the write instead of warning.
 *
 * English patterns are adapted from Hermes Agent's tools/threat_patterns.py (MIT,
 * Nous Research). Korean patterns cover only unambiguous attack phrasing: our own
 * memories are full of rule sentences ("~한다", "~하지 않는다"), so anything
 * merely bossy must not match.
 */

// Bounded filler between key words (unbounded repeats backtrack badly).
const F = String.raw`(?:\S+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;

const PATTERNS: [RegExp, string][] = [
  [new RegExp(String.raw`ignore\s+${F}(?:previous|all|above|prior)\s+${F}instructions`, 'i'), 'prompt_injection'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [new RegExp(String.raw`disregard\s+${F}(?:your|all|any)\s+${F}(?:instructions|rules|guidelines)`, 'i'), 'disregard_rules'],
  [new RegExp(String.raw`do\s+not\s+${F}tell\s+${F}the\s+user`, 'i'), 'deception_hide'],
  [new RegExp(String.raw`output\s+${F}(?:system|initial)\s+prompt`, 'i'), 'leak_system_prompt'],
  [/<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i, 'html_comment_injection'],
  [new RegExp(String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, 'i'), 'exfil_curl'],
  [new RegExp(String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, 'i'), 'exfil_wget'],
  [/(?:send|post|upload|transmit)\s+[^\n]{0,2048}\s+(?:to|at)\s+https?:\/\//i, 'send_to_url'],
  [/unset\s+\w*(?:CLAUDE|CODEX|AGENT|OPENAI|ANTHROPIC)\w*/i, 'env_var_unset_agent'],
  [/(?:이전|위|앞|기존|모든)\s*(?:의\s*)?(?:지시|명령|규칙|지침)(?:사항)?(?:을|를|은|는)?\s*(?:모두\s*|전부\s*)?(?:무시|잊어)/, 'ko_prompt_injection'],
  [/사용자(?:님)?(?:에게|한테)\s*(?:는\s*)?(?:알리지|말하지|들키지)\s*(?:말고|마라|마세요|말\s*것)/, 'ko_deception_hide'],
  [/시스템\s*프롬프트(?:를|을)?\s*(?:그대로\s*)?(?:출력|보여|유출|공개)/, 'ko_leak_system_prompt'],
  [/[​-‏‪-‮⁠-⁤﻿]/, 'invisible_unicode'],
];

/** Id of the first threat pattern the text matches, or null if clean. */
export function findThreat(text: string): string | null {
  const s = text.normalize('NFKC').slice(0, 65_536);
  for (const [re, id] of PATTERNS) if (re.test(s)) return id;
  return null;
}

/** Throws if the text matches a threat pattern; `what` names the write for the message. */
export function assertNoThreat(text: string, what: string): void {
  const id = findThreat(text);
  if (id) throw new Error(`${what} 저장 거절: 프롬프트 주입·유출 패턴(${id})에 걸림. 지시문이 섞였는지 확인하고 사실만 다시 쓴다.`);
}
