import { afterEach, describe, expect, test } from 'vitest';
import { buildChildEnv } from './cli-child-env';
import type { CLIToolConfig } from '@/models/providers/cli-provider';

const tool = (modelProvider: CLIToolConfig['modelProvider']) => ({ modelProvider }) as CLIToolConfig;
const saved = { ...process.env };
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe('buildChildEnv (shared by the agent worker and one-shot completions)', () => {
  test('server secrets never reach a vendor CLI', () => {
    process.env.DATABASE_URL = 'postgres://secret';
    process.env.MASTER_KEY = 'vault';
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.CLAUDECODE = '1';
    const env = buildChildEnv(tool('openai'));
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('MASTER_KEY');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CLAUDECODE');
  });

  test('provider keys pass only on opt-in, and only the matching provider', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    const env = buildChildEnv(tool('openai'), { VIBE_HOME: '/tmp/x' }, true);
    expect(env.OPENAI_API_KEY).toBe('sk-openai');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.VIBE_HOME).toBe('/tmp/x');
  });

  test('Windows system vars vendor CLIs probe pass through', () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:/Git/bin/bash.exe';
    process.env['ProgramFiles(x86)'] = 'C:/PF86';
    process.env.USERNAME = 'me';
    const env = buildChildEnv(tool('anthropic'));
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:/Git/bin/bash.exe');
    expect(env['ProgramFiles(x86)']).toBe('C:/PF86');
    expect(env.USERNAME).toBe('me');
  });
});
