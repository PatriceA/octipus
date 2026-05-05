import { describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';

/**
 * Phase 4 guard — no static shortlist arrays in src/api/routes/models.ts
 * or src/models/providers/discovery/. The shortlist must always derive from
 * a fresh API response.
 *
 * We allow id-pattern *regexes* (curation rules) and test fixtures, but
 * forbid concrete model id literals like 'gpt-4o' / 'claude-sonnet-4-5'
 * outside of test files.
 */
describe('no-static-shortlist guard', () => {
  it('src/api/routes/models.ts has no hardcoded model ids', () => {
    const out = execSync(
      `grep -E "(claude|gpt|gemini)-[0-9]" src/api/routes/models.ts || true`,
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('');
  });

  it('discovery/ source files have no hardcoded id arrays', () => {
    const out = execSync(
      `grep -REn "id:\\s*['\\"](claude|gpt|gemini|deepseek|llama)-" src/models/providers/discovery/ --include="*.ts" --exclude="*.test.ts" || true`,
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('');
  });
});
