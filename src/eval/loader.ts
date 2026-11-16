/**
 * YAML test suite loader.
 * Loads .yaml/.yml files from the eval/ directory at project root,
 * parses them into EvalSuite objects, and validates against schema.
 */

import { basename, extname, resolve } from 'path';
import { STATE_TABLE_ASSERTIONS, type StateQuery, validateFixtures, validateStateQuery } from './state';
import type { Assertion, AssertionType, EvalSuite, EvalTest } from './types';
import { fileAt, globFiles } from '@/utils/fs-file';

const VALID_ASSERTION_TYPES: Set<string> = new Set([
  'routes_to_role', 'uses_tool', 'not_uses_tool',
  'contains', 'not_contains', 'matches_regex',
  'classification', 'confidence_above', 'output_mode',
  'response_quality', 'latency_under',
  'no_hallucination', 'follows_format', 'token_count_under',
  'defense_held',
  'recalls_memory',
  'db_rows', ...Object.keys(STATE_TABLE_ASSERTIONS),
]);

const STATE_TYPES = new Set(['db_rows', ...Object.keys(STATE_TABLE_ASSERTIONS)]);

// ── Lightweight YAML parser ──────────────────────────────────────────
// Handles the subset needed for eval suites: scalars, arrays, objects.
// For anything more complex, swap in js-yaml.

export function parseYaml(text: string): unknown {
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

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0' };

function unescapeDoubleQuoted(body: string): string {
  return body.replace(/\\(.)/g, (whole, ch: string) => DOUBLE_QUOTED_ESCAPES[ch] ?? whole);
}

function parseScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Quoted string. Double quotes take YAML's escapes, so a regex is written
  // as in any YAML file (`"\\d+"` is the regex `\d+`); the raw text used to be
  // kept, doubling every backslash a suite wrote. An unknown escape keeps its
  // backslash. Single quotes escape only the quote itself (`''`).
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeDoubleQuoted(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
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

    // Inline array item: - value (a quoted scalar may contain a colon)
    if (afterDash && (!afterDash.includes(':') || /^["']/.test(afterDash))) {
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
  if (a.kind !== undefined && a.kind !== 'process' && a.kind !== 'outcome') {
    throw new Error(`Test "${testId}": assertion kind must be "process" or "outcome" (got "${String(a.kind)}")`);
  }
  if (a.failure !== undefined && !['unsafe', 'incomplete', 'other'].includes(String(a.failure))) {
    throw new Error(`Test "${testId}": assertion failure must be unsafe, incomplete or other (got "${String(a.failure)}")`);
  }
  const assertion: Assertion = {
    type: a.type as AssertionType,
    value: a.value as Assertion['value'],
    weight: typeof a.weight === 'number' ? a.weight : undefined,
    description: typeof a.description === 'string' ? a.description : undefined,
    id: typeof a.id === 'string' ? a.id : undefined,
    kind: a.kind as Assertion['kind'],
    failure: a.failure as Assertion['failure'],
  };
  if (STATE_TYPES.has(a.type)) {
    // The parser reads `{ a: b }` flow mappings as a string; refuse rather than
    // drop the filter and count every row.
    for (const field of ['where', 'matches'] as const) {
      if (a[field] !== undefined && (typeof a[field] !== 'object' || a[field] === null || Array.isArray(a[field]))) {
        throw new Error(`Test "${testId}": ${field} must be a block mapping (one "column: value" per line)`);
      }
    }
    const query: StateQuery = {
      table: typeof a.table === 'string' ? a.table : (STATE_TABLE_ASSERTIONS[a.type] ?? ''),
      ...(a.where && typeof a.where === 'object' ? { where: a.where as Record<string, unknown> } : {}),
      ...(a.matches && typeof a.matches === 'object' ? { matches: a.matches as Record<string, string> } : {}),
      ...(typeof a.count === 'number' ? { count: a.count } : {}),
      ...(typeof a.min === 'number' ? { min: a.min } : {}),
      ...(typeof a.max === 'number' ? { max: a.max } : {}),
      ...(a.since === 'all' || a.since === 'test' ? { since: a.since } : {}),
    };
    if (a.type === 'memory_absent') {
      if (typeof a.value !== 'string' || !a.value) throw new Error(`Test "${testId}": memory_absent needs a value (the pattern no memory may match)`);
      query.matches = { content: a.value };
      query.count = 0;
    }
    try {
      validateStateQuery(query);
    } catch (err) {
      throw new Error(`Test "${testId}": ${(err as Error).message}`);
    }
    assertion.query = query;
  }
  return assertion;
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
  if (Array.isArray(raw.memorySetup)) {
    test.memorySetup = (raw.memorySetup as Record<string, unknown>[]).map((m, i) => {
      if (!m.factType || !m.content) {
        throw new Error(`Test "${raw.id}": memorySetup[${i}] needs both "factType" and "content".`);
      }
      return {
        factType: String(m.factType),
        content: String(m.content),
        agentScope: m.agentScope ? String(m.agentScope) : undefined,
      };
    });
  }
  if (Array.isArray(raw.stateSetup)) {
    test.stateSetup = (raw.stateSetup as Record<string, unknown>[]).map((row, i) => {
      if (typeof row.table !== 'string' || !row.values || typeof row.values !== 'object') {
        throw new Error(`Test "${raw.id}": stateSetup[${i}] needs "table" and "values".`);
      }
      return { table: row.table, values: row.values as Record<string, unknown>, ...(typeof row.as === 'string' ? { as: row.as } : {}) };
    });
    try {
      validateFixtures(test.stateSetup);
    } catch (err) {
      throw new Error(`Test "${raw.id}": ${(err as Error).message}`);
    }
  }
  if (Array.isArray(raw.cleanup)) test.cleanup = (raw.cleanup as unknown[]).map(String);
  if (raw.trigger !== undefined) {
    if (raw.trigger !== 'chat' && raw.trigger !== 'companion_wake') {
      throw new Error(`Test "${raw.id}": trigger must be "chat" or "companion_wake".`);
    }
    test.trigger = raw.trigger;
  }
  if (raw.wake && typeof raw.wake === 'object') {
    const wake = raw.wake as Record<string, unknown>;
    if (typeof wake.goal !== 'string') throw new Error(`Test "${raw.id}": wake.goal must name a fixture row ($goal).`);
    test.wake = { goal: wake.goal, ...(typeof wake.session === 'string' ? { session: wake.session } : {}),
      ...(typeof wake.state === 'string' ? { state: wake.state } : {}) };
  }
  if (test.trigger === 'companion_wake' && !test.wake) throw new Error(`Test "${raw.id}": trigger companion_wake needs wake.goal.`);
  if (typeof raw.fixturePage === 'string') test.fixturePage = raw.fixturePage;
  if (typeof raw.settleMs === 'number') test.settleMs = raw.settleMs;
  if (raw.tier === 'unit' || raw.tier === 'live') test.tier = raw.tier;
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
  const file = fileAt(filePath);
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

  for await (const entry of globFiles('*.{yaml,yml}', { cwd: dir, absolute: false })) {
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
