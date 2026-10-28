const SENSITIVE_KEY = /password|passwd|passphrase|token|secret|api[_-]?key|credential|authorization|cookie/i;
const SECRET_SYNTAX = /[\w-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=]|--[\w-]*(?:password|token|secret|api[_-]?key|credential)[\w-]*(?:\s|=)|--(?:proxy-)?user(?:\s|=)|(?:^|\s)-[uU]/i;
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\r\n]*@/gi;

/** Span lexer only for logging, never execution. Consume the COMPLETE shell
 * word, including concatenated quotes/escapes, so a credential's suffix cannot
 * survive a replacement that stopped at an escaped or differently quoted quote.
 */
function words(command: string): Array<{ start: number; end: number; value: string }> {
  const result: Array<{ start: number; end: number; value: string }> = [];
  let i = 0;
  while (i < command.length) {
    if (/[\s;&|<>]/.test(command[i])) { i++; continue; }
    const start = i;
    let quote = '', value = '';
    while (i < command.length) {
      const c = command[i];
      if (quote === "'") {
        if (c === "'") quote = ''; else value += c;
        i++; continue;
      }
      if (c === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        if (next !== '\n') value += next;
        i += 2; continue;
      }
      if (quote === '"') {
        if (c === '"') quote = ''; else value += c;
        i++; continue;
      }
      if (c === "'" || c === '"') { quote = c; i++; continue; }
      if (/[\s;&|<>]/.test(c)) break;
      value += c; i++;
    }
    result.push({ start, end: i, value });
  }
  return result;
}

/** Preserve useful command structure without retaining common credentials. */
export function redactedCommand(command: string): string {
  const source = command.replace(/\{\{secret:[^}]+\}\}/g, '[REDACTED]');
  let output = '', cursor = 0, redactNext = false;
  for (const word of words(source)) {
    const raw = source.slice(word.start, word.end);
    const equals = word.value.indexOf('=');
    const key = equals < 0 ? word.value : word.value.slice(0, equals);
    let replacement = raw;
    if (redactNext) {
      replacement = '[REDACTED]'; redactNext = false;
    } else if (equals >= 0 && /^(?:--)?[\w-]+$/.test(key) && (SENSITIVE_KEY.test(key) || /^--(?:proxy-)?user$/i.test(key))) {
      replacement = `${key}=[REDACTED]`;
    } else if (/^--(?:proxy-)?user$|^-[uU]$/.test(word.value) || /^--?[\w-]+$/.test(word.value) && SENSITIVE_KEY.test(key)) {
      redactNext = true;
    } else if (/^-[uU].+/.test(word.value)) {
      replacement = `${word.value.slice(0, 2)}[REDACTED]`;
    } else if (SECRET_SYNTAX.test(word.value)) {
      // Header/JSON/inline-source arguments can contain arbitrary nested quote
      // styles. Redact the whole word rather than trying to recover a value.
      replacement = '[REDACTED]';
    } else {
      const scrubbed = word.value.replace(URI_CREDENTIALS, '$1[REDACTED]@')
        .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]');
      if (scrubbed !== word.value) replacement = scrubbed;
    }
    output += source.slice(cursor, word.start) + replacement;
    cursor = word.end;
  }
  return (output + source.slice(cursor)).slice(0, 2000);
}
