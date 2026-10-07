// Static scanners for agent-generated diffs.
// These run before any merge. They do not use an LLM.
// If a scanner flags something, the fork is quarantined, not silently fixed.

export interface ScanResult {
  passed: boolean;
  findings: string[];
}

// Matches common credential formats. Add patterns as needed.
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "aws-secret-key", re: /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "stripe-key", re: /sk_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "generic-api-key", re: /(api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "private-key", re: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "bearer-token", re: /bearer\s+[A-Za-z0-9_\-\.=~+/]{20,}/i },
];

export function scanSecrets(diff: string): ScanResult {
  const findings: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(diff)) findings.push(`possible ${name} in diff`);
  }
  return { passed: findings.length === 0, findings };
}

// Looks for prompt injection patterns in code comments and strings.
// Treats all code content as untrusted data, per project directives.
const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore-instructions", re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i },
  { name: "system-prompt-override", re: /you\s+are\s+now\s+(a|an)\s+/i },
  { name: "exfiltration", re: /fetch\s*\(\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/i },
  { name: "hidden-unicode", re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/ },
  { name: "eval-obfuscation", re: /eval\s*\(\s*(atob|String\.fromCharCode|unescape)/ },
  { name: "comment-directive", re: /\/\/\s*(TODO|FIXME|NOTE|HACK)\s*:\s*(run|execute|delete|drop|send)/i },
];

export function scanInjection(diff: string): ScanResult {
  const findings: string[] = [];
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(diff)) findings.push(`possible ${name} in diff`);
  }
  return { passed: findings.length === 0, findings };
}

// Flags dependency changes for separate review. Agents pick vulnerable
// versions often enough that lockfile diffs need their own gate.
export function scanDependencies(diff: string): ScanResult {
  const findings: string[] = [];
  const lockfileChanged = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)/.test(diff);
  if (lockfileChanged) findings.push("lockfile changed, requires dependency review");
  const newDep = /^\+\s*"(dependencies|devDependencies)"|^\+.*"(.*)":\s*"\^?~?[0-9]/.test(diff);
  if (newDep) findings.push("new dependency added, requires review");
  return { passed: findings.length === 0, findings };
}

export function runAllScans(diff: string): ScanResult {
  const all: string[] = [];
  for (const scan of [scanSecrets, scanInjection, scanDependencies]) {
    const result = scan(diff);
    all.push(...result.findings);
  }
  return { passed: all.length === 0, findings: all };
}
