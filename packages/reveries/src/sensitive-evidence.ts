/**
 * Heuristic checks for credential formats that must never enter public
 * Reveries evidence. A clean result is not proof that text contains no secret.
 */
export const SECRET_SCAN_WARNING =
  "Secret scanning detects common credential patterns only; review evidence manually because it cannot prove that evidence is secret-free.";

export type SecretPatternKind =
  | "private-key"
  | "aws-access-key"
  | "github-token"
  | "slack-token"
  | "stripe-key"
  | "bearer-token"
  | "jwt"
  | "credential-assignment"
  | "credential-url";

export interface SecretFinding {
  readonly kind: SecretPatternKind;
  readonly start: number;
}

const SECRET_PATTERNS: readonly {
  readonly kind: SecretPatternKind;
  readonly pattern: RegExp;
}[] = [
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "credential-assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*["']?(?!<|\[|your\b|placeholder\b)[A-Za-z0-9/+_=-]{8,}/gi,
  },
  { kind: "credential-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]{8,}@/gi },
];

/** Return pattern categories and offsets without retaining matched secret bytes. */
export function scanSecretMaterial(value: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index !== undefined) findings.push({ kind, start: match.index });
    }
  }
  return findings.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
}

/** Refuse to add recognizable credential text without echoing that text. */
export function assertNoSecretMaterial(value: string, context = "Evidence"): void {
  const findings = scanSecretMaterial(value);
  if (findings.length === 0) return;
  const kinds = [...new Set(findings.map(({ kind }) => kind))].join(", ");
  throw new Error(`${context} contains likely secret material (${kinds}). Do not store secrets in Reveries evidence. ${SECRET_SCAN_WARNING}`);
}
