import { describe, expect, test } from 'vitest';
import { buildChildEnv, isSensitiveEnvName } from './child-env';

/** Plant vars, run `fn`, restore whatever was there before. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('isSensitiveEnvName', () => {
  test('catches the telltale word anywhere in the name, not only at the end', () => {
    // The anchored version this replaced read AWS_SECRET_ACCESS_KEY as safe.
    for (const name of [
      'MASTER_KEY',
      'DATABASE_URL',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_KEY',
      'OPENAI_API_KEY',
      'SLACK_BOT_TOKEN',
      'GH_TOKEN_FILE',
      'DB_PASSWORD',
      'MY_CREDENTIALS_PATH',
    ]) {
      expect(isSensitiveEnvName(name)).toBe(true);
    }
  });

  test('leaves ordinary settings alone — the filter is not "strip everything"', () => {
    for (const name of ['PATH', 'HOME', 'LANG', 'NODE_ENV', 'OLLAMA_HOST', 'TZ']) {
      expect(isSensitiveEnvName(name)).toBe(false);
    }
  });
});

describe('buildChildEnv', () => {
  test('a spawned child sees settings but not credentials', () => {
    const env = withEnv({ MASTER_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'y', HARMLESS: 'kept' }, () =>
      buildChildEnv(),
    );
    expect(env.MASTER_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HARMLESS).toBe('kept');
    expect(env.PATH).toBeDefined();
  });

  test('a named keep carries one credential through, and only that one', () => {
    const env = withEnv({ GH_TOKEN: 'gh-value', SLACK_BOT_TOKEN: 'slack-value' }, () =>
      buildChildEnv(undefined, { keep: ['GH_TOKEN'] }),
    );
    // `gh` needs its own token; it does not need Slack's.
    expect(env.GH_TOKEN).toBe('gh-value');
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  test('an explicit value wins over the filter', () => {
    const env = withEnv({ MASTER_KEY: 'inherited' }, () =>
      buildChildEnv({ MASTER_KEY: 'passed-on-purpose' }),
    );
    expect(env.MASTER_KEY).toBe('passed-on-purpose');
  });
});
