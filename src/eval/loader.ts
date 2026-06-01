/**
 * YAML test suite loader.
 * Loads .yaml/.yml files from the eval/ directory at project root,
 * parses them into EvalSuite objects, and validates against schema.
 */

import { basename, extname, resolve } from 'path';
import type { Assertion, AssertionType, EvalSuite, EvalTest } from './types';

const VALID_ASSERTION_TYPES: Set<string> = new Set([
  'routes_to_role', 'uses_tool', 'not_uses_tool',
  'contains', 'not_contains', 'matches_regex',
  'classification', 'confidence_above', 'output_mode',
  'response_quality', 'latency_under',
  'no_hallucination', 'follows_format', 'token_count_under',
]);

// ── Lightweight YAML parser ──────────────────────────────────────────
// Handles the subset needed for eval suites: scalars, arrays, objects.
// For anything more complex, swap in js-yaml.

function parseYaml(text: string): unknown {
  const lines = text.split('\n');
  return parseBlock(lines, 0, 0).value;
}

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

function parseScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // Number
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') return num;

  return trimmed;
}

function parseBlock(lines: string[], startLine: number, minIndent: number): ParseResult {
  // Skip blanks/comments
  let i = startLine;
  while (i < lines.length && isBlankOrComment(lines[i])) i++;
  if (i >= lines.length) return { value: null, nextLine: i };

  const line = lines[i];
  const indent = getIndent(line);
  const trimmed = line.trim();

  // Array item
  if (trimmed.startsWith('- ')) {
    return parseArray(lines, i, indent);
  }

  // Key-value
  if (trimmed.includes(':')) {
    return parseMapping(lines, i, indent);
  }

  // Plain scalar
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

    // Inline array item: - value
    if (afterDash && !afterDash.includes(':')) {
      // Check for flow array: [a, b, c]
      if (afterDash.startsWith('[') && afterDash.endsWith(']')) {
        const inner = afterDash.slice(1, -1);
        result.push(inner.split(',').map(s => parseScalar(s.trim())));
      } else {
        result.push(parseScalar(afterDash));
      }
      i++;
      continue;
    }

    // Array item with nested mapping: - key: value
    if (afterDash && afterDash.includes(':')) {
      // Rewrite as a mapping at deeper indent
      const itemIndent = baseIndent + 2;
      const synthLines = [...lines];
      synthLines[i] = ' '.repeat(itemIndent) + afterDash;

      // Collect nested lines that belong to this item
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

    // Array item with nested block (next lines indented)
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

    // Must be a key: value line
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) break;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === '' || rest === '|' || rest === '>') {
      // Block value — look ahead
      i++;

      // Multi-line string (| or >)
      if (rest === '|' || rest === '>') {
        let text = '';
        while (i < lines.length) {
          if (isBlankOrComment(lines[i]) && lines[i].trim() === '') {
            text += '\n';
            i++;
            continue;
          }
          const nextIndent = getIndent(lines[i]);
          if (nextIndent <= baseIndent) break;
          text += (text ? (rest === '|' ? '\n' : ' ') : '') + lines[i].trim();
          i++;
        }
        result[key] = text;
        continue;
      }

      const nested = parseBlock(lines, i, baseIndent + 2);
      result[key] = nested.value;
      i = nested.nextLine;
    } else {
      // Inline flow array: [a, b, c]
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

// ── Validation ───────────────────────────────────────────────────────

function validateAssertion(a: Record<string, unknown>, testId: string): Assertion {
  if (!a.type || typeof a.type !== 'string') {
    throw new Error(`Test "${testId}": assertion missing "type" field`);
  }
  if (!VALID_ASSERTION_TYPES.has(a.type)) {
    console.warn(`Test "${testId}": unknown assertion type "${a.type}" (will be treated as custom)`);
  }
  return {
    type: a.type as AssertionType,
    value: a.value as Assertion['value'],
    weight: typeof a.weight === 'number' ? a.weight : undefined,
    description: typeof a.description === 'string' ? a.description : undefined,
  };
}

function validateTest(raw: Record<string, unknown>): EvalTest {
  if (!raw.id || typeof raw.id !== 'string') {
    throw new Error('Test missing "id" field');
  }
  if (!raw.input || typeof raw.input !== 'string') {
    throw new Error(`Test "${raw.id}": missing "input" field`);
  }
  if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
    throw new Error(`Test "${raw.id}": must have at least one assertion`);
  }

  const test: EvalTest = {
    id: raw.id,
    description: (raw.description as string) || raw.id,
    input: raw.input,
    assertions: (raw.assertions as Record<string, unknown>[]).map(a =>
      validateAssertion(a, raw.id as string),
    ),
  };

  if (raw.context && typeof raw.context === 'object') {
    test.context = raw.context as EvalTest['context'];
  }
  if (raw.expected) test.expected = String(raw.expected);
  if (Array.isArray(raw.tags)) {
    test.tags = (raw.tags as unknown[]).map(String);
  }
  if (raw.metadata && typeof raw.metadata === 'object') {
    test.metadata = raw.metadata as Record<string, unknown>;
  }

  return test;
}

function validateSuite(raw: Record<string, unknown>, filename: string): EvalSuite {
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error(`Suite in ${filename}: missing "name" field`);
  }
  if (!Array.isArray(raw.tests) || raw.tests.length === 0) {
    throw new Error(`Suite "${raw.name}": must have at least one test`);
  }

  return {
    name: raw.name,
    description: raw.description ? String(raw.description) : undefined,
    tests: (raw.tests as Record<string, unknown>[]).map(validateTest),
    defaultModel: raw.defaultModel ? String(raw.defaultModel) : undefined,
    defaultTimeout: typeof raw.defaultTimeout === 'number' ? raw.defaultTimeout : undefined,
    metadata: raw.metadata as Record<string, unknown> | undefined,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load a single YAML eval suite from a file path.
 */
export async function loadSuiteFromFile(filePath: string): Promise<EvalSuite> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Suite file not found: ${filePath}`);
  }
  const text = await file.text();
  const raw = parseYaml(text) as Record<string, unknown>;
  return validateSuite(raw, basename(filePath));
}

/**
 * Load all YAML eval suites from the eval/ directory.
 * Optionally filter by suite name (matched against filename without extension).
 */
export async function loadSuites(
  evalDir?: string,
  filterName?: string,
): Promise<EvalSuite[]> {
  const dir = evalDir || resolve(process.cwd(), 'eval');
  const suites: EvalSuite[] = [];

  const glob = new Bun.Glob('*.{yaml,yml}');
  for await (const entry of glob.scan({ cwd: dir, absolute: false })) {
    const name = basename(entry, extname(entry));
    if (filterName && name !== filterName) continue;

    const filePath = resolve(dir, entry);
    try {
      const suite = await loadSuiteFromFile(filePath);
      suites.push(suite);
    } catch (err) {
      console.error(`Failed to load suite ${entry}:`, (err as Error).message);
    }
  }

  if (suites.length === 0) {
    const hint = filterName ? ` matching "${filterName}"` : '';
    console.warn(`No eval suites found in ${dir}${hint}`);
  }

  return suites;
}
