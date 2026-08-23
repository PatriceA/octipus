import { describe, expect, test } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adminRegisterHint,
  ApiError,
  type BootstrapConfig,
  buildEnv,
  readExistingSecrets,
  readlinePrompt,
} from './setup-wizard';

/**
 * The interactive flow (pi-tui, backend boot, API calls) needs a PTY
 * harness — that lives in the dedicated e2e suite. Here we just verify
 * the pure .env builder enforces the secrets-only contract: secrets +
 * pre-DB storage + bootstrap one-shots, nothing else.
 */

const KEYS = {
  masterKey: 'm'.repeat(44),
  jwtSecret: 'j'.repeat(44),
  sessionSecret: 's'.repeat(44),
};

const BASE: BootstrapConfig = {
  storageMode: 'embedded',
  databaseUrl: '',
  dataDir: '/tmp/data',
  apiPort: '3005',
  apiHost: '127.0.0.1',
  bootstrapProvider: '',
  bootstrapModel: '',
  bootstrapApiKey: '',
  bootstrapBaseUrl: '',
};

describe('setup-wizard — buildEnv', () => {
  test('embedded mode emits DATA_DIR, no DATABASE_URL', () => {
    const env = buildEnv(BASE, KEYS);
    expect(env).toContain('STORAGE_MODE=embedded');
    expect(env).toContain('DATA_DIR=/tmp/data');
    expect(env).not.toContain('DATABASE_URL=');
  });

  test('external mode emits DATABASE_URL and no DATA_DIR', () => {
    const env = buildEnv(
      { ...BASE, storageMode: 'external', databaseUrl: 'postgresql://u:p@h:5432/db', dataDir: '' },
      KEYS,
    );
    expect(env).toContain('STORAGE_MODE=external');
    expect(env).toContain('DATABASE_URL=postgresql://u:p@h:5432/db');
    // External storage is Postgres now; there is no second service to point at.
    expect(env).not.toContain('REDIS_URL');
    expect(env).not.toContain('DATA_DIR=');
  });

  test('always emits security keys', () => {
    const env = buildEnv(BASE, KEYS);
    expect(env).toContain(`MASTER_KEY=${KEYS.masterKey}`);
    expect(env).toContain(`JWT_SECRET=${KEYS.jwtSecret}`);
    expect(env).toContain(`SESSION_SECRET=${KEYS.sessionSecret}`);
  });

  test('always emits API_HOST and API_PORT (bootstrap, needed pre-DB)', () => {
    const env = buildEnv(BASE, KEYS);
    expect(env).toContain('API_HOST=127.0.0.1');
    expect(env).toContain('API_PORT=3005');
  });

  test('bootstrap provider + model land when set', () => {
    const env = buildEnv({ ...BASE, bootstrapProvider: 'ollama', bootstrapModel: 'llama3.2:3b' }, KEYS);
    expect(env).toContain('BOOTSTRAP_PROVIDER=ollama');
    expect(env).toContain('BOOTSTRAP_MODEL=llama3.2:3b');
    expect(env).not.toContain('BOOTSTRAP_API_KEY=');
  });

  test('bootstrap API key + base URL only when present', () => {
    const env = buildEnv(
      { ...BASE, bootstrapProvider: 'openrouter', bootstrapModel: 'openai/gpt-4o-mini', bootstrapApiKey: 'sk-test-redacted' },
      KEYS,
    );
    expect(env).toContain('BOOTSTRAP_API_KEY=sk-test-redacted');
    expect(env).not.toContain('BOOTSTRAP_BASE_URL=');
  });

  test('skip path — no BOOTSTRAP_* block at all', () => {
    const env = buildEnv(BASE, KEYS);
    expect(env).not.toContain('BOOTSTRAP_PROVIDER');
    expect(env).not.toContain('BOOTSTRAP_MODEL');
  });

  test('does NOT emit CORS or generic PORT/HOST — those live in DB', () => {
    const env = buildEnv(BASE, KEYS);
    expect(env).not.toMatch(/^PORT=/m);
    expect(env).not.toMatch(/^HOST=/m);
    expect(env).not.toMatch(/^CORS_ORIGINS=/m);
  });
});

/**
 * Rerun safety: a second `bun run setup` must reuse the existing MASTER_KEY,
 * not regenerate it — a fresh key orphans everything the vault has encrypted.
 * readExistingSecrets is the parse half; buildEnv round-trips back to it.
 */
describe('setup-wizard — readExistingSecrets (rerun safety)', () => {
  function tmpEnv(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'octi-setup-')), '.env');
    writeFileSync(path, contents);
    return path;
  }

  test('returns null when the file does not exist', () => {
    expect(readExistingSecrets(join(tmpdir(), 'octi-nope-does-not-exist', '.env'))).toBeNull();
  });

  test('parses all three secrets from a real generated .env', () => {
    const path = tmpEnv(buildEnv(BASE, KEYS));
    expect(readExistingSecrets(path)).toEqual(KEYS);
  });

  test('returns null if any secret is missing (force fresh generation)', () => {
    const path = tmpEnv('MASTER_KEY=abc\nJWT_SECRET=def\n'); // no SESSION_SECRET
    expect(readExistingSecrets(path)).toBeNull();
  });

  test('tolerates comments, blank lines, and surrounding whitespace', () => {
    const path = tmpEnv(
      ['# header', '', '  MASTER_KEY = m1 ', 'JWT_SECRET=j1', 'SESSION_SECRET=s1', ''].join('\n'),
    );
    expect(readExistingSecrets(path)).toEqual({ masterKey: 'm1', jwtSecret: 'j1', sessionSecret: 's1' });
  });
});

/**
 * Admin registration is the step that opaquely failed with a raw 422 in the
 * field. adminRegisterHint maps each status to the field the user can fix.
 */
describe('setup-wizard — adminRegisterHint', () => {
  const e = (status: number, body: string) => new ApiError('POST', '/api/auth/register', status, body);

  test('422 with an email blames the email format (and mentions blank-to-skip)', () => {
    const msg = adminRegisterHint(e(422, '{"error":"Invalid request data"}'), { username: 'mo', email: 'not-an-email' });
    expect(msg).toContain('HTTP 422');
    expect(msg).toContain('not-an-email');
    expect(msg).toMatch(/valid email|leave it blank/i);
  });

  test('422 without an email blames the username length', () => {
    const msg = adminRegisterHint(e(422, '{"error":"Invalid request data"}'), { username: 'mo' });
    expect(msg).toContain('HTTP 422');
    expect(msg).toMatch(/3.?50 characters/);
    expect(msg).not.toMatch(/email/i);
  });

  test('400 surfaces the backend password-complexity message verbatim', () => {
    const msg = adminRegisterHint(e(400, '{"error":"Password must contain at least one uppercase letter"}'), {
      username: 'mauricio',
    });
    expect(msg).toContain('Password must contain at least one uppercase letter');
  });

  test('409 explains the conflict', () => {
    const msg = adminRegisterHint(e(409, '{"error":"Username already exists"}'), { username: 'mauricio' });
    expect(msg).toMatch(/already registered/i);
  });

  test('429 tells the user to wait and rerun', () => {
    const msg = adminRegisterHint(e(429, '{"error":"Too many"}'), { username: 'mauricio' });
    expect(msg).toMatch(/wait .* rerun setup/i);
  });

  test('non-ApiError falls back to its message', () => {
    const msg = adminRegisterHint(new Error('connection refused'), { username: 'mauricio' });
    expect(msg).toContain('connection refused');
  });

  test('ApiError.serverMessage extracts {error} from JSON, else raw text', () => {
    expect(e(422, '{"error":"nope"}').serverMessage).toBe('nope');
    expect(e(500, 'plain text crash').serverMessage).toBe('plain text crash');
  });
});

/**
 * The post-backend phase runs on plain stdout (the pi-tui context is torn
 * down before the backend boots), so prompts fall back to `readlinePrompt`.
 * These cover the path the TTY-error fix newly enables — in particular that
 * masked fields (admin password, provider/API keys) never echo their input.
 */
describe('setup-wizard — readlinePrompt fallback', () => {
  async function prompt(text: string, mask: boolean) {
    const input = new PassThrough();
    let captured = '';
    const output = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });
    const pending = readlinePrompt('PROMPT> ', { mask, input, output });
    for (const ch of text) input.write(ch);
    input.write('\r');
    const answer = await pending;
    return { answer, captured };
  }

  test('returns the typed answer', async () => {
    const { answer } = await prompt('embedded', false);
    expect(answer).toBe('embedded');
  });

  test('unmasked input is echoed to the terminal', async () => {
    const { answer, captured } = await prompt('hunter2', false);
    expect(answer).toBe('hunter2');
    expect(captured).toContain('hunter2');
  });

  test('masked input is NOT echoed (no secret on screen/scrollback)', async () => {
    const secret = 'S3cret-Passw0rd';
    const { answer, captured } = await prompt(secret, true);
    // Value still captured correctly...
    expect(answer).toBe(secret);
    // ...but never written to the output stream.
    expect(captured).not.toContain(secret);
    // The prompt itself is still shown before muting kicks in.
    expect(captured).toContain('PROMPT>');
  });
});
