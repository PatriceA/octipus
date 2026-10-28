/** Preserve diagnostic command structure without logging common credentials. */
export function redactedCommand(command: string): string {
  return command
    .replace(/\{\{secret:[^}]+\}\}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*)(?:(?:bearer|basic)\s+)?[^\s'";]+/gi, '$1[REDACTED]')
    .replace(/((?:^|[\s?&'"])(?:--?)?[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*\s*(?:[:=]|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s;&'"]+)/gi, '$1[REDACTED]')
    .replace(/(["'][\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,}]+)/gi, '$1"[REDACTED]"')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .slice(0, 2000);
}
