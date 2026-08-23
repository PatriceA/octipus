import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 4 guard — no static shortlist arrays in src/api/routes/models.ts
 * or src/models/providers/discovery/. The shortlist must always derive from
 * a fresh API response.
 *
 * We allow id-pattern *regexes* (curation rules) and test fixtures, but
 * forbid concrete model id literals like 'gpt-4o' / 'claude-sonnet-4-5'
 * outside of test files.
 *
 * Implemented in pure JS (no execSync('grep ...')) so the suite runs on
 * Windows too — the previous shell-out died with the cmd.exe parser
 * trying to interpret regex literals as commands.
 */

interface MatchHit { file: string; line: number; text: string }

/** Walk a directory and return every file path whose name matches `predicate`. */
function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) {
      out.push(...listFiles(full, predicate));
    } else if (predicate(name)) {
      out.push(full);
    }
  }
  return out;
}

function grep(files: string[], pattern: RegExp): MatchHit[] {
  const hits: MatchHit[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file, line: i + 1, text });
    });
  }
  return hits;
}

describe('no-static-shortlist guard', () => {
  it('src/api/routes/models.ts has no hardcoded model ids', () => {
    const hits = grep(['src/api/routes/models.ts'], /(claude|gpt|gemini)-[0-9]/);
    expect(hits).toEqual([]);
  });

  it('discovery/ source files have no hardcoded id arrays', () => {
    const sources = listFiles('src/models/providers/discovery', (n) =>
      n.endsWith('.ts') && !n.endsWith('.test.ts'),
    );
    const hits = grep(sources, /id:\s*['"](claude|gpt|gemini|deepseek|llama)-/);
    expect(hits).toEqual([]);
  });
});
