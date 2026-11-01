import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { browserRuntimeDiagnostic } from './runtime-path';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('distinguishes missing cache, missing revision and inaccessible existing runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-browser-diagnostic-')); dirs.push(dir);
  const cache = join(dir, 'cache'); vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', cache);
  const expected = join(cache, 'chromium-999', 'chrome');
  const error = `Executable doesn't exist at ${expected}\n`;
  expect(browserRuntimeDiagnostic(error)).toContain('cache is absent');
  mkdirSync(join(cache, 'chromium-999'), { recursive: true });
  expect(browserRuntimeDiagnostic(error)).toContain('revision that is missing');
  writeFileSync(expected, '');
  expect(browserRuntimeDiagnostic(error)).toContain('exists on the host');
  expect(browserRuntimeDiagnostic('test assertion failed')).toBeUndefined();
});
