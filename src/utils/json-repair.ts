/**
 * Best-effort repair for malformed JSON emitted by LLM tool-call streams.
 *
 * Targets the common failure modes from chat-completion providers where the
 * `arguments` payload is truncated mid-stream:
 *   - Unterminated string at EOF (most common: long `content` parameter cut
 *     mid-line)
 *   - Trailing unclosed `{` / `[`
 *   - Trailing comma before the truncation point
 *
 * NOT a general JSON repairer. We do not try to fix:
 *   - Broken escape sequences in the middle of a string
 *   - Missing keys/values mid-object
 *   - Single-quote strings (no provider in production does this)
 *
 * Returns `null` if the input doesn't look recoverable — caller surfaces
 * the original parse error so we don't silently feed garbage downstream.
 */
export function repairTruncatedJson(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  let inString = false;
  let escapeNext = false;
  const stack: Array<'{' | '['> = [];
  let lastNonWsBeforeTruncation = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null;
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) {
        return null;
      }
    }
    if (ch.trim() !== '') lastNonWsBeforeTruncation = i;
  }

  let repaired = input;

  if (inString) {
    if (escapeNext) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  if (!inString && lastNonWsBeforeTruncation >= 0) {
    const lastCh = input[lastNonWsBeforeTruncation];
    if (lastCh === ',') {
      repaired = repaired.slice(0, lastNonWsBeforeTruncation)
        + repaired.slice(lastNonWsBeforeTruncation + 1);
    } else if (lastCh === ':') {
      repaired += 'null';
    }
  }

  while (stack.length > 0) {
    const open = stack.pop();
    repaired += open === '{' ? '}' : ']';
  }

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}
