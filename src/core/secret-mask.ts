/**
 * Secret-looking strings, replaced before anything is stored. The rule is "never paste keys",
 * but a slip shouldn't end up in the archive forever.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\b((?:aws_secret_access_key|api[_-]?key|secret|token|password)\s*[:=]\s*["']?)[^\s"']{8,}/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, re) => out.replace(re, (_m, prefix?: string) => `${typeof prefix === 'string' ? prefix : ''}[REDACTED]`),
    text,
  );
}

/**
 * Where secret-looking strings are: 1-based line, start and length within that line (a private key block
 * counts on its first line, up to the line end), one per line and in line order.
 */
export function secretSpans(text: string): { line: number; start: number; length: number }[] {
  const spans = new Map<number, { line: number; start: number; length: number }>();
  for (const re of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const before = text.slice(0, m.index);
      const line = before.split('\n').length;
      const start = m.index - (before.lastIndexOf('\n') + 1);
      if (!spans.has(line)) spans.set(line, { line, start, length: m[0].split(/\r?\n/)[0].length });
    }
  }
  return [...spans.values()].sort((a, b) => a.line - b.line);
}
