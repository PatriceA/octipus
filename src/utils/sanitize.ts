const DEFAULT_MAX_LENGTH = 50_000;

/**
 * Sanitize tool output for inclusion in LLM messages.
 * Converts to string and truncates if over limit.
 */
export function sanitizeToolOutput(
  output: unknown,
  options: { maxLength?: number } = {}
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  let str: string;
  if (typeof output === 'string') {
    str = output;
  } else if (output === null || output === undefined) {
    return '';
  } else {
    try {
      str = JSON.stringify(output);
    } catch {
      str = String(output);
    }
  }

  if (str.length > maxLength) {
    return str.slice(0, maxLength) + ' [truncated]';
  }

  return str;
}
