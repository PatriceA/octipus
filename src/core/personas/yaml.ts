/**
 * Lightweight YAML parser for persona files.
 *
 * Handles the subset personas need: scalars, arrays, nested maps,
 * arrays of maps, and `|` block strings. Copied from
 * `src/eval/loader.ts` to avoid pulling in a YAML dependency and to
 * keep this module self-contained. If a third consumer appears,
 * lift to `src/utils/yaml.ts`.
 */

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Strip a trailing YAML comment (`  # …`) from an unquoted scalar.
 * Comments inside quoted strings are preserved.
 */
function stripInlineComment(s: string): string {
  // Quoted strings keep their content verbatim.
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed;
  }
  // Strip `# …` when preceded by whitespace OR at the start of the
  // value. `#tag` mid-token without a leading space stays.
  const hashIdx = s.search(/(^|\s)#/);
  if (hashIdx < 0) return s;
  return s.slice(0, hashIdx).trimEnd();
}

function parseScalar(raw: string): string | number | boolean | null {
  const stripped = stripInlineComment(raw);
  const trimmed = stripped.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;

  return trimmed;
}

function parseBlock(lines: string[], startLine: number, _minIndent: number): ParseResult {
  let i = startLine;
  while (i < lines.length && isBlankOrComment(lines[i])) i++;
  if (i >= lines.length) return { value: null, nextLine: i };

  const line = lines[i];
  const indent = getIndent(line);
  const trimmed = line.trim();

  if (trimmed.startsWith('- ')) {
    return parseArray(lines, i, indent);
  }

  if (trimmed.includes(':')) {
    return parseMapping(lines, i, indent);
  }

  return { value: parseScalar(trimmed), nextLine: i + 1 };
}

function parseArray(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const result: unknown[] = [];
  let i = startLine;

  while (i < lines.length) {
    if (isBlankOrComment(lines[i])) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < baseIndent) break;
    if (indent !== baseIndent) break;

    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('- ')) break;

    const afterDash = trimmed.slice(2).trim();

    if (afterDash && !afterDash.includes(':')) {
      if (afterDash.startsWith('[') && afterDash.endsWith(']')) {
        const inner = afterDash.slice(1, -1);
        result.push(inner.split(',').map(s => parseScalar(s.trim())));
      } else {
        result.push(parseScalar(afterDash));
      }
      i++;
      continue;
    }

    if (afterDash && afterDash.includes(':')) {
      const itemIndent = baseIndent + 2;
      const nestedLines: string[] = [' '.repeat(itemIndent) + afterDash];
      let j = i + 1;
      while (j < lines.length) {
        if (isBlankOrComment(lines[j])) { nestedLines.push(lines[j]); j++; continue; }
        const nextIndent = getIndent(lines[j]);
        if (nextIndent <= baseIndent) break;
        nestedLines.push(lines[j]);
        j++;
      }
      const parsed = parseMapping(nestedLines, 0, itemIndent);
      result.push(parsed.value);
      i = j;
      continue;
    }

    i++;
    const nested = parseBlock(lines, i, baseIndent + 2);
    result.push(nested.value);
    i = nested.nextLine;
  }

  return { value: result, nextLine: i };
}

function parseMapping(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    if (isBlankOrComment(lines[i])) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < baseIndent) break;
    if (indent !== baseIndent) break;

    const trimmed = lines[i].trim();

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) break;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === '' || rest === '|' || rest === '>') {
      i++;

      if (rest === '|' || rest === '>') {
        // For block scalars, capture content at any indent greater than
        // the key's. Preserve relative indentation inside the block so
        // markdown-style sub-bullets in persona prompts survive.
        let text = '';
        let firstIndent = -1;
        while (i < lines.length) {
          if (isBlankOrComment(lines[i]) && lines[i].trim() === '') {
            text += '\n';
            i++;
            continue;
          }
          const nextIndent = getIndent(lines[i]);
          if (nextIndent <= baseIndent) break;
          if (firstIndent < 0) firstIndent = nextIndent;
          // Trim only the block's base indent so relative nesting is preserved.
          const stripped = lines[i].slice(Math.min(firstIndent, nextIndent));
          text += (text ? (rest === '|' ? '\n' : ' ') : '') + stripped;
          i++;
        }
        result[key] = text;
        continue;
      }

      const nested = parseBlock(lines, i, baseIndent + 2);
      result[key] = nested.value;
      i = nested.nextLine;
    } else {
      if (rest.startsWith('[') && rest.endsWith(']')) {
        const inner = rest.slice(1, -1);
        result[key] = inner.split(',').map(s => parseScalar(s.trim()));
      } else {
        result[key] = parseScalar(rest);
      }
      i++;
    }
  }

  return { value: result, nextLine: i };
}

/**
 * Parse a YAML string into a plain JS value. Throws on truly
 * malformed structure; permissive on unknown keys (caller validates).
 */
export function parseYaml(text: string): unknown {
  const lines = text.split('\n');
  return parseBlock(lines, 0, 0).value;
}
